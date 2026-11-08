import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { authenticated, authenticatedPage } from '../src/browser.mjs';

function sessionPage(body, { status = 200, url = 'https://grok.com/c/test', closed = false } = {}) {
  const requests = [];
  return {
    requests, url: () => url, isClosed: () => closed,
    evaluate: callback => vm.runInNewContext(`(${callback.toString()})()`, {
      location: { origin: new URL(url).origin },
      AbortSignal,
      fetch: async (path, options) => {
        requests.push({ path, options });
        return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
      },
    }),
  };
}

test('executes the real browser check against Grok status/session/userId format', async () => {
  const page = sessionPage({ status: 'authenticated', session: { userId: 'test-user-id', email: 'not-exported@example.invalid' } });
  assert.equal(await authenticated(page), true);
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].path, '/api/auth/session');
  assert.equal(page.requests[0].options.cache, 'no-store');
  assert.equal(page.requests[0].options.credentials, 'same-origin');
});

test('legacy user object works without treating explicit sign-out as authenticated', async () => {
  assert.equal(await authenticated(sessionPage({ user: { id: 'legacy-id' } })), true);
  assert.equal(await authenticated(sessionPage({ user: { email: 'test@example.invalid' } })), true);
  assert.equal(await authenticated(sessionPage({ status: 'unauthenticated', user: { id: 'stale-id' } })), false);
});

test('anonymous sessions return false, but unfamiliar successful payloads remain verification errors', async () => {
  for (const body of [null, {}, { user: null }, { status: 'unauthenticated' }, { status: 'anonymous' }]) {
    assert.equal(await authenticated(sessionPage(body)), false);
  }
  for (const body of [{ status: 'authenticated' }, { status: 'authenticated', session: { userId: '' } }, { unexpected: 'data' }, []]) {
    await assert.rejects(authenticated(sessionPage(body)), { code: 'session_schema_unsupported' });
  }
});

test('browser session check preserves HTTP failure distinctions', async () => {
  assert.equal(await authenticated(sessionPage({}, { status: 401 })), false);
  await assert.rejects(authenticated(sessionPage({}, { status: 429 })), { code: 'rate_limit_exceeded' });
  await assert.rejects(authenticated(sessionPage({}, { status: 403 })), { code: 'session_unavailable' });
  await assert.rejects(authenticated(sessionPage({}, { url: 'https://accounts.google.com/' })), { code: 'session_unavailable' });
});

test('account login finds the authenticated Grok tab after an OAuth popup or tab change', async () => {
  const initial = sessionPage({ status: 'unauthenticated' });
  const google = sessionPage({}, { url: 'https://accounts.google.com/' });
  const signedIn = sessionPage({ status: 'authenticated', session: { userId: 'signed-in' } });
  assert.equal(await authenticatedPage({ pages: () => [initial, google, signedIn] }), signedIn);
  assert.equal(initial.requests.length, 0);
  assert.equal(google.requests.length, 0);
});

test('tab scanning skips closed pages and does not hide unknown session formats', async () => {
  const closed = sessionPage({}, { closed: true });
  const unknown = sessionPage({ status: 'authenticated' });
  const anonymous = sessionPage({ status: 'unauthenticated' });
  await assert.rejects(authenticatedPage({ pages: () => [unknown, anonymous, closed] }), { code: 'session_schema_unsupported' });
  assert.equal(closed.requests.length, 0);
  assert.equal(await authenticatedPage({ pages: () => [anonymous] }), null);
});
