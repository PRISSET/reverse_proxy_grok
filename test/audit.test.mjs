import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditLog } from '../src/audit.mjs';
import { Store } from '../src/store.mjs';
import { AccountPool } from '../src/pool.mjs';
import { ProxyError } from '../src/errors.mjs';

async function fixture(t, limit = 100) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grok-audit-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audit = new AuditLog(path.join(root, 'log.json'), { limit }); await audit.init();
  return { root, audit };
}

test('sticky chat stays on account1 until limit, then replays the same input on account2 and logs correlation', async t => {
  const { root, audit } = await fixture(t);
  const store = new Store(path.join(root, 'state')); await store.init();
  for (const id of ['account1', 'account2']) await store.save({ id, status: 'ready', cooldownUntil: 0 });
  let firstCalls = 0;
  const input = { prompt: 'private-prompt-not-for-log', images: [Buffer.from('private-image')] };
  const attempted = [];
  const pool = new AccountPool(store, async (account, received) => {
    assert.equal(received, input);
    attempted.push(account.id);
    if (account.id === 'account1' && ++firstCalls === 3) throw new ProxyError('private-token-not-for-log', 429, 'rate_limit_exceeded', 20);
    return { text: 'private-answer-not-for-log' };
  }, { now: () => 1000, audit: event => audit.record(event) });
  for (const requestId of ['one', 'two', 'three']) {
    await pool.execute(input, () => {}, undefined, { requestId, strategy: 'sticky' });
  }
  assert.deepEqual(attempted, ['account1', 'account1', 'account1', 'account2']);
  const events = audit.snapshot().events.filter(event => event.request_id === 'three');
  assert.deepEqual(events.map(event => event.event), ['request_started', 'account_selected', 'rate_limited', 'failover', 'account_selected', 'request_completed']);
  assert.equal(events[3].from_account, 'account1');
  assert.equal(events[3].to_account, 'account2');
  assert.equal((await store.read('account1')).cooldownUntil, 21000);
  const raw = await readFile(audit.file, 'utf8');
  assert.doesNotMatch(raw, /private-prompt|private-token|private-answer|private-image/);
});

test('concurrent audit writes remain valid JSON, bounded, private and restartable', async t => {
  const { audit } = await fixture(t, 5);
  await Promise.all(Array.from({ length: 12 }, (_, n) => audit.record({
    event: 'account_selected', request_id: `request-${n}`, account_id: 'first',
    cookies: 'secret-cookie', castle_request_token: 'secret-token', prompt: 'secret-prompt',
  })));
  const saved = JSON.parse(await readFile(audit.file, 'utf8'));
  assert.equal(saved.events.length, 5);
  assert.deepEqual(saved.events.map(event => event.sequence), [8, 9, 10, 11, 12]);
  assert.equal((await stat(audit.file)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(saved), /secret/);
  const restored = new AuditLog(audit.file, { limit: 5 }); await restored.init();
  await restored.record({ event: 'request_completed', request_id: 'last' });
  assert.equal(restored.snapshot().last_sequence, 13);
  assert.equal(restored.snapshot(12).events.length, 1);
});

test('partial rate-limited reply logs failure without a failover event', async t => {
  const { root, audit } = await fixture(t);
  const store = new Store(path.join(root, 'state')); await store.init();
  for (const id of ['first', 'second']) await store.save({ id, status: 'ready' });
  const pool = new AccountPool(store, async (_account, _input, emit) => {
    emit('partial'); throw new ProxyError('limited', 429, 'rate_limit_exceeded', 1);
  }, { audit: event => audit.record(event) });
  await assert.rejects(pool.execute({}, () => {}, undefined, { requestId: 'partial', strategy: 'sticky' }), { code: 'rate_limit_exceeded' });
  const events = audit.snapshot().events;
  assert.ok(events.some(event => event.event === 'rate_limited' && event.partial));
  assert.ok(events.some(event => event.event === 'request_failed'));
  assert.ok(!events.some(event => event.event === 'failover'));
});
