import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, stat, symlink, mkdir, readlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { loginAccount } from '../src/account-login.mjs';
import { browserCloser } from '../src/sessions.mjs';
import { recoverLock } from '../src/lock-recovery.mjs';
import { bounded } from '../src/deadline.mjs';

const never = () => new Promise(() => {});
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grok-login-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root); await store.init();
  await store.save({ id: 'first', status: 'ready', authorizedAt: 'original' });
  await writeFile(path.join(store.dir('first'), 'session-cookies.json'), '{"cookies":[]}', { mode: 0o600 });
  const context = new EventEmitter();
  context.pages = () => [{ goto: async () => {} }];
  context.cookies = async () => [{ name: 'test-session', value: 'test-only-secret', domain: '.grok.com', path: '/', expires: -1 }];
  context.close = async () => context.emit('close');
  const settings = {
    launch: async () => context, verify: async () => ({}), log: () => {},
    checkTimeout: 15, cookieTimeout: 15, closeTimeout: 15,
  };
  const run = () => loginAccount(store, 'first', { question: async () => '' }, new AbortController().signal, {}, settings);
  return { store, context, settings, run };
}

test('confirmed session is durably marked ready before browser close starts', async t => {
  const { store, context, run, settings } = await fixture(t);
  const output = []; settings.log = line => output.push(line);
  context.close = async () => {
    assert.notEqual((await store.read('first')).authorizedAt, 'original');
    const saved = JSON.parse(await readFile(path.join(store.dir('first'), 'session-cookies.json'), 'utf8'));
    assert.equal(saved.cookies.length, 1);
    context.emit('close');
  };
  await run();
  await assert.rejects(stat(path.join(store.dir('first'), 'in-use.lock')), { code: 'ENOENT' });
  assert.ok(output.some(line => line.includes('СОХРАНЕНО')));
  assert.ok(output.at(-1).includes('Готово'));
});

test('hanging browser close times out after session save and retains its profile lock', async t => {
  const { store, context, run } = await fixture(t);
  context.close = never;
  await assert.rejects(run(), { code: 'browser_close_timeout' });
  assert.equal((await store.read('first')).status, 'ready');
  assert.notEqual((await store.read('first')).authorizedAt, 'original');
  assert.equal(JSON.parse(await readFile(path.join(store.dir('first'), 'session-cookies.json'), 'utf8')).cookies.length, 1);
  assert.ok(await stat(path.join(store.dir('first'), 'in-use.lock')));
});

test('hanging auth check and hanging cookie capture preserve previous saved sessions', async t => {
  for (const stage of ['verify', 'cookies']) {
    const { store, context, settings, run } = await fixture(t);
    if (stage === 'verify') settings.verify = never;
    else context.cookies = never;
    await assert.rejects(run(), { code: stage === 'verify' ? 'session_check_timeout' : 'cookies_timeout' });
    assert.equal((await store.read('first')).authorizedAt, 'original');
    assert.equal(await readFile(path.join(store.dir('first'), 'session-cookies.json'), 'utf8'), '{"cookies":[]}');
    await assert.rejects(stat(path.join(store.dir('first'), 'in-use.lock')), { code: 'ENOENT' });
  }
});

test('close event completes cleanup even if the driver close promise hangs', async t => {
  const { store, context } = await fixture(t);
  context.close = () => { context.emit('close'); return never(); };
  const close = browserCloser(store, 'first', context, { save: false, timeout: 15 });
  await close();
  assert.equal(close.closed, true);
});

test('deadline returns promptly on cancellation without awaiting a stalled operation', async () => {
  const cancel = new AbortController();
  const result = bounded(never, { timeout: 1000, signal: cancel.signal });
  cancel.abort();
  await assert.rejects(result, { code: 'cancelled' });
});

test('recover removes only a dead application lock, preserving cookies and Chrome lock', async t => {
  const { store } = await fixture(t);
  const file = path.join(store.dir('first'), 'in-use.lock');
  await writeFile(file, '123\n');
  await mkdir(store.profile('first'));
  await symlink('test-host-456', path.join(store.profile('first'), 'SingletonLock'));
  assert.equal(await recoverLock(store, 'first', { isRunning: () => false, hostname: 'test-host' }), true);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(store.dir('first'), 'session-cookies.json'), 'utf8'), '{"cookies":[]}');
  assert.equal(await readlink(path.join(store.profile('first'), 'SingletonLock')), 'test-host-456');
  assert.equal(await recoverLock(store, 'first'), false);
});

test('recover refuses live account process, live Chrome or foreign namespace', async t => {
  const { store } = await fixture(t);
  const file = path.join(store.dir('first'), 'in-use.lock');
  await writeFile(file, '123\n');
  await assert.rejects(recoverLock(store, 'first', { isRunning: () => true }), { code: 'account_busy' });
  await mkdir(store.profile('first'));
  await symlink('test-host-456', path.join(store.profile('first'), 'SingletonLock'));
  await assert.rejects(recoverLock(store, 'first', { isRunning: pid => pid === 456, hostname: 'test-host' }), { code: 'account_busy' });
  await writeFile(file, JSON.stringify({ pid: 123, hostname: 'test-host', namespace: 'other' }));
  await assert.rejects(recoverLock(store, 'first', { isRunning: () => false, hostname: 'test-host', namespace: async () => 'ours' }), { code: 'account_busy' });
  assert.ok(await stat(file));
});

test('unlock never removes a replacement lock owned by another attempt', async t => {
  const { store } = await fixture(t);
  const unlock = await store.lock('first');
  const file = path.join(store.dir('first'), 'in-use.lock');
  await writeFile(file, 'replacement-owner');
  await unlock();
  assert.equal(await readFile(file, 'utf8'), 'replacement-owner');
});
