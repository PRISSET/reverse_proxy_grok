import { ProxyError, checkAbort } from './errors.mjs';
import { randomUUID } from 'node:crypto';

export class AccountPool {
  constructor(store, worker, { cooldown = 300000, now = Date.now, audit = async () => {} } = {}) {
    this.store = store;
    this.worker = worker;
    this.cooldown = cooldown;
    this.now = now;
    this.busy = new Set();
    this.cursor = 0;
    this.audit = audit;
  }
  async status() {
    return (await this.store.list()).map(a => ({
      id: a.id, status: a.status, busy: this.busy.has(a.id),
      cooldown_until: a.cooldownUntil || null,
    }));
  }
  async execute(input, onDelta = () => {}, signal, { requestId = randomUUID(), strategy = 'round_robin' } = {}) {
    const tried = new Set();
    let emitted = false;
    let rateLimited = false;
    let previous = null;
    await this.audit({ event: 'request_started', request_id: requestId, strategy });
    while (true) {
      try { checkAbort(signal); }
      catch (error) {
        await this.audit({ event: 'request_failed', request_id: requestId, code: 'cancelled', partial: emitted });
        throw error;
      }
      const accounts = await this.store.list();
      const available = accounts.filter(a => a.status === 'ready' && !this.busy.has(a.id)
        && !tried.has(a.id) && (a.cooldownUntil || 0) <= this.now());
      if (!available.length) {
        const cooling = accounts.filter(a => a.status === 'ready' && a.cooldownUntil > this.now());
        const retry = cooling.length ? Math.max(1, Math.ceil((Math.min(...cooling.map(a => a.cooldownUntil)) - this.now()) / 1000)) : null;
        await this.audit({ event: 'accounts_exhausted', request_id: requestId,
          code: rateLimited || cooling.length ? 'rate_limit_exceeded' : 'no_available_accounts', retry_after: retry });
        throw new ProxyError(rateLimited || cooling.length ? 'All available accounts are rate limited' : 'No ready account is available',
          rateLimited || cooling.length ? 429 : 503, rateLimited || cooling.length ? 'rate_limit_exceeded' : 'no_available_accounts', retry);
      }
      let account = available[strategy === 'sticky' ? 0 : this.cursor++ % available.length];
      // Reserve without another await: simultaneous requests cannot select the same profile.
      if (this.busy.has(account.id)) continue;
      this.busy.add(account.id);
      tried.add(account.id);
      let unlock;
      let retainLock = false;
      try {
        unlock = await this.store.lock(account.id);
        account = await this.store.read(account.id);
        if (account.status !== 'ready' || account.cooldownUntil > this.now()) continue;
        if (previous) {
          await this.audit({ event: 'failover', request_id: requestId, from_account: previous.id,
            to_account: account.id, code: previous.code, attempt: tried.size });
          previous = null;
        }
        await this.audit({ event: 'account_selected', request_id: requestId, account_id: account.id, attempt: tried.size });
        const result = await this.worker(account, input, delta => {
          emitted = true;
          onDelta(delta);
        }, signal);
        await this.audit({ event: 'request_completed', request_id: requestId, account_id: account.id, attempt: tried.size });
        return { ...result, accountId: account.id, requestId, attempts: tried.size };
      } catch (error) {
        if (error.code === 'rate_limit_exceeded') {
          const pause = error.retryAfter == null ? this.cooldown : Math.max(1, error.retryAfter) * 1000;
          const cooldownUntil = this.now() + pause;
          await this.store.save({ ...account, cooldownUntil });
          await this.audit({ event: 'rate_limited', request_id: requestId, account_id: account.id,
            cooldown_until: cooldownUntil, retry_after: Math.ceil(pause / 1000), partial: emitted, code: error.code });
          rateLimited = true;
          if (!emitted) { previous = { id: account.id, code: error.code }; continue; }
        }
        if (error.code === 'auth_required') {
          await this.store.save({ ...account, status: 'auth_required' });
          await this.audit({ event: 'auth_required', request_id: requestId, account_id: account.id, code: error.code });
          if (!emitted) { previous = { id: account.id, code: error.code }; continue; }
        }
        if (error.code === 'account_busy' && !emitted) {
          await this.audit({ event: 'account_busy', request_id: requestId, account_id: account.id, code: error.code });
          continue;
        }
        retainLock = error.code === 'browser_close_timeout';
        await this.audit({ event: 'request_failed', request_id: requestId, account_id: account.id,
          code: error.code || 'upstream_error', stage: error.stage, partial: emitted });
        throw error;
      } finally {
        try { if (!retainLock) await unlock?.(); }
        finally { this.busy.delete(account.id); }
      }
    }
  }
}
