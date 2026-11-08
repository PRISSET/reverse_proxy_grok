import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './store.mjs';

const events = new Set(['request_started', 'account_selected', 'rate_limited', 'auth_required', 'account_busy', 'failover', 'request_completed', 'request_failed', 'accounts_exhausted']);
const codes = new Set(['rate_limit_exceeded', 'auth_required', 'account_busy', 'cancelled', 'upstream_error', 'no_available_accounts', 'browser_unavailable', 'browser_driver_missing', 'browser_close_timeout', 'session_check_timeout', 'session_unavailable', 'session_schema_unsupported', 'castle_token_missing', 'castle_token_reused', 'protocol_error', 'connection_closed', 'incomplete_response', 'upstream_timeout', 'upload_timeout', 'upload_failed', 'ui_changed', 'browser_operation_failed', 'cookies_timeout', 'response_too_large', 'browser_profile_mismatch']);

export class AuditLog {
  constructor(file, { limit = 2000 } = {}) {
    this.file = file;
    this.limit = limit;
    this.events = [];
    this.sequence = 0;
    this.queue = Promise.resolve();
  }
  async init() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.events)) throw new Error('Invalid log.json');
      this.events = saved.events.slice(-this.limit);
      this.sequence = this.events.at(-1)?.sequence || 0;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await atomicJson(this.file, this.snapshot());
  }
  snapshot(after = 0) {
    return { version: 1, last_sequence: this.sequence, events: this.events.filter(event => event.sequence > after) };
  }
  record(data) {
    // Allowlisted metadata only. Prompts, responses, error messages, headers and tokens are never copied.
    if (!events.has(data.event)) return Promise.reject(new Error('Invalid audit event'));
    const safe = { event: data.event };
    for (const key of ['request_id', 'account_id', 'from_account', 'to_account']) {
      if (typeof data[key] === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(data[key])) safe[key] = data[key];
    }
    if (data.code) safe.code = codes.has(data.code) || ['castle_sdk_unavailable', 'gateway_handshake_timeout', 'upstream_http_error', 'browser_api_mismatch', 'browser_context_closed', 'navigation_failed', 'castle_discovery_failed', 'gateway_evaluation_failed'].includes(data.code) ? data.code : 'upstream_error';
    if (['navigation', 'castle', 'gateway', 'response'].includes(data.stage)) safe.stage = data.stage;
    if (['sticky', 'round_robin'].includes(data.strategy)) safe.strategy = data.strategy;
    for (const key of ['attempt', 'cooldown_until', 'retry_after', 'status']) {
      if (Number.isFinite(data[key])) safe[key] = data[key];
    }
    if (typeof data.partial === 'boolean') safe.partial = data.partial;
    const write = async () => {
      const entry = { sequence: ++this.sequence, timestamp: new Date().toISOString(), ...safe };
      this.events.push(entry);
      this.events = this.events.slice(-this.limit);
      await atomicJson(this.file, this.snapshot());
    };
    const result = this.queue.then(write);
    this.queue = result.catch(() => {});
    return result;
  }
  async flush() { await this.queue; }
}
