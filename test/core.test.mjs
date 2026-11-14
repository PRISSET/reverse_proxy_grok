import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { AccountPool } from '../src/pool.mjs';
import { ProxyError } from '../src/errors.mjs';
import { normalize } from '../src/input.mjs';
import { config } from '../src/config.mjs';
import { Exchange } from '../src/exchange.mjs';
import { frame, textChunk, upstreamError, retryAfter } from '../src/protocol.mjs';
import { authenticated, openBrowser } from '../src/browser.mjs';
import { browserProfile, launchOptions } from '../src/browser-profile.mjs';
import { browserCloser, restoreSessionCookies } from '../src/sessions.mjs';

async function storeFixture(t, ids = ['first', 'second']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grok-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  await store.init();
  for (const id of ids) await store.save({ id, status: 'ready', cooldownUntil: 0 });
  return store;
}

test('account sessions and key are private; profile lock is exclusive', async t => {
  const store = await storeFixture(t);
  const first = await store.apiKey();
  assert.equal(first, await store.apiKey());
  assert.equal((await stat(store.root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(store.root, 'api-key'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(store.dir('first'), 'account.json'))).mode & 0o777, 0o600);
  const unlock = await store.lock('first');
  await assert.rejects(store.lock('first'), { code: 'account_busy' });
  await unlock();
  await (await store.lock('first'))();
  assert.throws(() => store.profile('../bad'), { code: 'invalid_account' });
});

test('rate limit cools only affected account and retries another', async t => {
  const store = await storeFixture(t);
  const attempts = [];
  const pool = new AccountPool(store, async account => {
    attempts.push(account.id);
    if (account.id === 'first') throw new ProxyError('limited', 429, 'rate_limit_exceeded', 17);
    return { text: 'ok' };
  }, { now: () => 1000 });
  assert.equal((await pool.execute({})).text, 'ok');
  assert.deepEqual(attempts, ['first', 'second']);
  assert.equal((await store.read('first')).cooldownUntil, 18000);
  assert.equal((await store.read('second')).cooldownUntil, 0);
  assert.equal(pool.busy.size, 0);
});

test('partial answer is never replayed on another account', async t => {
  const store = await storeFixture(t);
  let attempts = 0;
  const pool = new AccountPool(store, async (_account, _input, emit) => {
    attempts++;
    emit('partial');
    throw new ProxyError('limited', 429, 'rate_limit_exceeded');
  });
  await assert.rejects(pool.execute({}), { code: 'rate_limit_exceeded' });
  assert.equal(attempts, 1);
});

test('simultaneous requests reserve distinct profiles', async t => {
  const store = await storeFixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const active = new Set();
  const pool = new AccountPool(store, async account => {
    assert.ok(!active.has(account.id));
    active.add(account.id);
    if (active.size === 2) release();
    await gate;
    active.delete(account.id);
    return { text: account.id };
  });
  const result = await Promise.all([pool.execute({}), pool.execute({})]);
  assert.equal(new Set(result.map(item => item.text)).size, 2);
});

test('all cooling accounts return 429 with earliest retry time', async t => {
  const store = await storeFixture(t);
  await store.save({ id: 'first', status: 'ready', cooldownUntil: 11000 });
  await store.save({ id: 'second', status: 'ready', cooldownUntil: 6000 });
  const pool = new AccountPool(store, () => assert.fail('must not execute'), { now: () => 1000 });
  await assert.rejects(pool.execute({}), error => error.status === 429 && error.retryAfter === 5);
});

test('authentication failure retires an account; unknown errors do not rotate', async t => {
  const store = await storeFixture(t);
  const pool = new AccountPool(store, async account => {
    if (account.id === 'first') throw new ProxyError('login', 401, 'auth_required');
    return { text: 'ok' };
  });
  assert.equal((await pool.execute({})).text, 'ok');
  assert.equal((await store.read('first')).status, 'auth_required');
  let attempts = 0;
  const broken = new AccountPool(store, async () => {
    attempts++;
    throw new ProxyError('castle rejected', 502, 'upstream_error');
  });
  await assert.rejects(broken.execute({}), { code: 'upstream_error' });
  assert.equal(attempts, 1);
});

test('multi-image inputs preserve ordering and reject remote URLs and tool claims', () => {
  const image = 'data:image/png;base64,aGVsbG8=';
  const normalized = normalize({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'Compare' },
    { type: 'image_url', image_url: { url: image } },
    { type: 'image_url', image_url: { url: image } },
  ] }] }, config);
  assert.equal(normalized.images.length, 2);
  assert.equal(normalized.images[0].buffer.toString(), 'hello');
  assert.match(normalized.prompt, /Attached image 2/);
  assert.throws(() => normalize({ messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: 'http://127.0.0.1/private' } },
  ] }] }, config), { status: 400 });
  assert.throws(() => normalize({ messages: [{ role: 'user', content: 'x' }], tools: [{}] }, config), { status: 400 });
  assert.throws(() => normalize({ model: 'invented-model', messages: [{ role: 'user', content: 'x' }] }, config), { status: 400 });
});

test('Responses input keeps instructions and rejects unresolved file IDs', () => {
  const value = normalize({ instructions: 'Be precise', input: 'hello' }, config, true);
  assert.match(value.prompt, /SYSTEM:\nBe precise/);
  assert.match(value.prompt, /USER:\nhello/);
  assert.throws(() => normalize({ input: [{ role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }] }, config, true), { status: 400 });
});

test('protocol separates assistant text from reasoning and classifies explicit codes', () => {
  const event = frame(JSON.stringify({ event: { type: 'response.chunk', chunk: { channel: 'CHANNEL_ASSISTANT_RESPONSE', text: { text: 'answer' } } } }));
  assert.equal(textChunk(event), 'answer');
  assert.equal(textChunk({ ...event, chunk: { channel: 'CHANNEL_ASSISTANT_NOTETAKER_HEADER', text: { text: 'secret' } } }), '');
  assert.equal(upstreamError({ type: 'error', code: 'RESOURCE_EXHAUSTED' }).code, 'rate_limit_exceeded');
  assert.equal(upstreamError({ type: 'error', message: 'rate limit maybe' }).code, 'upstream_error');
  assert.equal(frame('not json'), null);
  assert.equal(retryAfter('12'), 12);
  assert.equal(retryAfter('bad'), null);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 1000), 9);
});

test('exchange requires fresh Castle token, ignores thinking and waits for terminal event', async () => {
  const output = [];
  const exchange = new Exchange(text => output.push(text), ['response.done']);
  exchange.received(JSON.stringify({ type: 'response.done' }));
  assert.equal(exchange.finished, false);
  exchange.sent(JSON.stringify({ event: { type: 'response.create', castle_request_token: 'test-only-token-unique-a' } }));
  exchange.received(JSON.stringify({ event: { type: 'response.chunk', chunk: { channel: 'CHANNEL_ASSISTANT_RESPONSE', text: { text: 'hi' } } } }));
  assert.equal(exchange.finished, false);
  exchange.received(JSON.stringify({ event: { type: 'response.done' } }));
  assert.equal(await exchange.promise, 'hi');
  assert.deepEqual(output, ['hi']);
  const repeated = new Exchange(() => {}, ['response.done']);
  repeated.sent(JSON.stringify({ type: 'response.create', castle_request_token: 'test-only-token-unique-a' }));
  await assert.rejects(repeated.promise, { code: 'castle_token_reused' });
});

test('missing token fails before text; failed completion stays an error', async () => {
  const missing = new Exchange(() => assert.fail('must not emit'), ['response.done']);
  missing.sent(JSON.stringify({ type: 'response.create' }));
  await assert.rejects(missing.promise, { code: 'castle_token_missing' });
  const failed = new Exchange(() => {}, ['response.done']);
  failed.sent(JSON.stringify({ type: 'response.create', castle_request_token: 'test-only-token-unique-b' }));
  failed.received(JSON.stringify({ type: 'response.done', response: { status: 'failed' } }));
  await assert.rejects(failed.promise, { code: 'incomplete_response' });
});

test('an empty incomplete response is a rate limit, a cut-off answer is not', async () => {
  const quota = new Exchange(() => {}, ['response.done']);
  quota.sent(JSON.stringify({ type: 'response.create', castle_request_token: 'test-only-token-unique-q1' }));
  quota.received(JSON.stringify({ type: 'response.done', response: { status: 'incomplete' } }));
  await assert.rejects(quota.promise, { code: 'rate_limit_exceeded', status: 429 });

  const cut = new Exchange(() => {}, ['response.done']);
  cut.sent(JSON.stringify({ type: 'response.create', castle_request_token: 'test-only-token-unique-q2' }));
  cut.received(JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }));
  cut.received(JSON.stringify({ type: 'response.done', response: { status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' } } }));
  await assert.rejects(cut.promise, { code: 'incomplete_response', message: /max_output_tokens/ });
});

test('a Grok stream_error is reported by kind: usage limits as rate limits', async () => {
  const limited = new Exchange(() => {}, ['response.done']);
  limited.sent(JSON.stringify({ type: 'response.create', castle_request_token: 'test-only-token-unique-s1' }));
  limited.received(JSON.stringify({ type: 'response.grok.output', output: { stream_error: {
    kind: 'usage_limit_reached', message: "You've reached your usage limit.", severity: 'normal' } } }));
  await assert.rejects(limited.promise, { code: 'rate_limit_exceeded', status: 429, message: /usage_limit_reached/ });

  const other = new Exchange(() => {}, ['response.done']);
  other.sent(JSON.stringify({ type: 'response.create', castle_request_token: 'test-only-token-unique-s2' }));
  other.received(JSON.stringify({ type: 'response.grok.output', output: { stream_error: { kind: 'model_overloaded' } } }));
  await assert.rejects(other.promise, { code: 'upstream_error', message: /model_overloaded/ });
});

test('exchange ignores other conversation and response IDs on the same socket', async () => {
  const exchange = new Exchange(() => {}, ['response.done']);
  const send = (session, event) => JSON.stringify({ session_id: session, event });
  exchange.sent(send('ours', { type: 'response.create', castle_request_token: 'test-only-token-unique-c' }));
  exchange.received(send('other', { type: 'error', code: '429' }));
  exchange.received(send('ours', { type: 'response.created', response: { id: 'r1' } }));
  exchange.received(send('ours', { type: 'response.done', response: { id: 'r2' } }));
  assert.equal(exchange.finished, false);
  exchange.received(send('ours', { type: 'response.chunk', response_id: 'r1', chunk: {
    channel: 'CHANNEL_ASSISTANT_RESPONSE', text: { text: 'correct' },
  } }));
  exchange.received(send('ours', { type: 'response.done', response: { id: 'r1', status: 'completed' } }));
  assert.equal(await exchange.promise, 'correct');
});

test('session network failure and rate limit never become an invalid-login diagnosis', async () => {
  const page = result => ({ evaluate: async () => result });
  assert.equal(await authenticated(page({ status: 200, authenticated: true })), true);
  assert.equal(await authenticated(page({ status: 200, authenticated: false })), false);
  assert.equal(await authenticated(page({ status: 401 })), false);
  await assert.rejects(authenticated(page({ status: 429, retry: '20' })), { code: 'rate_limit_exceeded', retryAfter: 20 });
  await assert.rejects(authenticated(page({ status: 0 })), { code: 'session_unavailable' });
  await assert.rejects(authenticated(page({ status: 403 })), { code: 'session_unavailable' });
});

test('session cookies survive closing, stay private and never override fresher cookies', async t => {
  const store = await storeFixture(t, ['first']);
  const cookie = { name: 'test-session', value: 'test-secret', domain: '.grok.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' };
  let closed = 0;
  const close = browserCloser(store, 'first', {
    cookies: async () => [cookie, { ...cookie, domain: '.example.com' }, { ...cookie, name: 'persistent', expires: 9999999999 }],
    close: async () => { closed++; },
  });
  await Promise.all([close(), close()]);
  assert.equal(closed, 1);
  assert.equal((await stat(path.join(store.dir('first'), 'session-cookies.json'))).mode & 0o777, 0o600);
  const restored = [];
  await restoreSessionCookies(store, 'first', { cookies: async () => [], addCookies: async cookies => restored.push(...cookies) });
  assert.deepEqual(restored, [cookie]);
  await restoreSessionCookies(store, 'first', {
    cookies: async () => [{ ...cookie, value: 'newer' }],
    addCookies: async () => assert.fail('must not overwrite current session'),
  });
});

test('native browser identity is persisted and reused with no UA or header injection', async t => {
  const store = await storeFixture(t, ['first', 'second']);
  const settings = { channel: 'chrome', locale: 'ru-RU', timezoneId: 'Europe/Berlin' };
  const first = await browserProfile(store, 'first', settings);
  assert.deepEqual(await browserProfile(store, 'first', { channel: 'chrome' }), first);
  assert.equal((await stat(path.join(store.dir('first'), 'browser-profile.json'))).mode & 0o777, 0o600);
  const options = launchOptions(first);
  assert.equal(options.viewport, null);
  assert.equal(options.headless, false);
  assert.equal(options.locale, 'ru-RU');
  assert.equal(options.timezoneId, 'Europe/Berlin');
  assert.equal(options.userAgent, undefined);
  assert.equal(options.extraHTTPHeaders, undefined);
  assert.equal(options.args, undefined);
  const second = await browserProfile(store, 'second', { ...settings, locale: 'en-GB' });
  assert.equal(second.locale, 'en-GB');
  assert.equal((await browserProfile(store, 'first', settings)).locale, 'ru-RU');
});

test('profile rejects identity changes but permits a headless background transport', async t => {
  const store = await storeFixture(t, ['first']);
  const settings = { channel: 'chrome', locale: 'en-US', timezoneId: 'Europe/Berlin' };
  await browserProfile(store, 'first', settings);
  for (const change of [{ channel: 'chromium' }, { locale: 'ru-RU' }, { timezoneId: 'UTC' }]) {
    await assert.rejects(browserProfile(store, 'first', { ...settings, ...change }), { code: 'browser_profile_mismatch' });
  }
  const background = await browserProfile(store, 'first', settings, true);
  assert.equal(background.headless, false);
  assert.equal(launchOptions(background, true).headless, true);
});

test('browser factory uses the saved identity and fails explicitly when the selected driver is missing', async t => {
  const store = await storeFixture(t, ['first']);
  const settings = { channel: 'chrome', headless: false, locale: 'en-US', timezoneId: 'Europe/Berlin' };
  let launched;
  const context = { close: async () => {} };
  const driver = async () => ({ chromium: { launchPersistentContext: async (directory, options) => {
    launched = { directory, options };
    return context;
  } } });
  assert.equal(await openBrowser(store, 'first', settings, false, driver), context);
  assert.equal(launched.directory, store.profile('first'));
  assert.equal(launched.options.viewport, null);
  assert.equal(launched.options.channel, 'chrome');
  assert.equal(launched.options.locale, 'en-US');
  await assert.rejects(openBrowser(store, 'first', settings, false, async () => {
    throw Object.assign(new Error('private module loader details'), { code: 'ERR_MODULE_NOT_FOUND' });
  }), error => error.code === 'browser_driver_missing' && !error.message.includes('private'));
});
