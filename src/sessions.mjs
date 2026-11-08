import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './store.mjs';
import { bounded } from './deadline.mjs';

const belongsToGrok = cookie => ['grok.com', '.grok.com'].includes(cookie.domain);
const identity = cookie => JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey]);

export async function restoreSessionCookies(store, id, context) {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(path.join(store.dir(id), 'session-cookies.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!Array.isArray(snapshot.cookies)) throw new Error('Invalid saved cookies');
  const current = new Set((await bounded(() => context.cookies(), { timeout: 10000, code: 'cookies_timeout', message: 'Chrome did not return cookies within 10 seconds' })).map(identity));
  // Existing profile cookies win; only session cookies lost during restart are restored.
  const missing = snapshot.cookies.filter(cookie => belongsToGrok(cookie)
    && cookie.expires === -1 && !current.has(identity(cookie)));
  if (missing.length) await bounded(() => context.addCookies(missing), { timeout: 10000, code: 'cookies_timeout', message: 'Chrome did not restore cookies within 10 seconds' });
}

export async function saveSessionCookies(store, id, context, { timeout = 10000, signal } = {}) {
  const cookies = (await bounded(() => context.cookies(), {
    timeout, signal, code: 'cookies_timeout', message: 'Chrome did not return cookies; the previous snapshot was preserved',
  })).filter(cookie => belongsToGrok(cookie) && cookie.expires === -1);
  await atomicJson(path.join(store.dir(id), 'session-cookies.json'), { cookies });
}

export function browserCloser(store, id, context, { timeout = 10000, cookieTimeout = 10000, save = true } = {}) {
  let closing;
  let closed = false;
  const didClose = () => { closed = true; };
  context.on?.('close', didClose);
  const close = () => {
    closing ??= (async () => {
      try {
        if (save && !closed) await saveSessionCookies(store, id, context, { timeout: cookieTimeout });
      } finally {
        if (!closed) {
          let listener;
          const event = new Promise(resolve => {
            listener = () => { closed = true; resolve(); };
            context.once?.('close', listener);
          });
          try {
            await bounded(() => Promise.race([Promise.resolve().then(() => context.close()), event]), {
              timeout, code: 'browser_close_timeout', message: 'Chrome did not close within 10 seconds. Close its window before retrying this account',
            });
            closed = true;
          } finally {
            context.removeListener?.('close', listener);
          }
        }
        context.removeListener?.('close', didClose);
      }
    })();
    return closing;
  };
  Object.defineProperty(close, 'closed', { get: () => closed });
  return close;
}
