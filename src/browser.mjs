import { privateDir } from './store.mjs';
import { ProxyError } from './errors.mjs';
import { retryAfter } from './protocol.mjs';
import { restoreSessionCookies } from './sessions.mjs';
import { browserProfile, launchOptions } from './browser-profile.mjs';
import { bounded } from './deadline.mjs';

export async function openBrowser(store, id, config, headless = config.headless, loadDriver = () => import('patchright')) {
  const profile = await browserProfile(store, id, config, headless);
  await privateDir(store.profile(id));
  let context;
  try {
    const { chromium } = await loadDriver();
    context = await chromium.launchPersistentContext(store.profile(id), launchOptions(profile, headless));
    await restoreSessionCookies(store, id, context);
    return context;
  } catch (error) {
    if (context) await bounded(() => context.close(), { timeout: 10000, code: 'browser_close_timeout' }).catch(() => {});
    if (error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new ProxyError('Patchright is not installed. Run npm install in the project directory', 503, 'browser_driver_missing');
    }
    throw new ProxyError('Chrome could not start. Check npm dependencies, Chrome installation, DISPLAY and profile locks', 503, 'browser_unavailable');
  }
}

export async function authenticated(page, { timeout = 15000, signal } = {}) {
  const result = await bounded(() => page.evaluate(async () => {
    if (location.origin !== 'https://grok.com') return { status: 0 };
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return { status: response.status, retry: response.headers.get('retry-after') };
      const session = await response.json();
      const identifier = value => typeof value === 'string' && value.trim().length > 0;
      if (session?.status === 'authenticated' && identifier(session.session?.userId)) {
        return { status: 200, authenticated: true };
      }
      if (session?.status === 'unauthenticated' || session?.status === 'anonymous') {
        return { status: 200, authenticated: false };
      }
      if ((session?.status === undefined || session.status === 'authenticated')
          && (identifier(session?.user?.id) || identifier(session?.user?.email))) {
        return { status: 200, authenticated: true };
      }
      if (session === null || (session && typeof session === 'object' && !Array.isArray(session)
          && (Object.keys(session).length === 0 || (session.user === null && session.status === undefined)))) {
        return { status: 200, authenticated: false };
      }
      return { status: 200, authenticated: null };
    } catch { return { status: 0 }; }
  }), { timeout, signal, code: 'session_check_timeout', message: 'Session verification timed out; restart login for this account' })
    .catch(error => {
      if (error instanceof ProxyError) throw error;
      throw new ProxyError('Grok tab changed or closed during session verification; retry the check', 502, 'session_unavailable');
    });
  if (result.status === 429) throw new ProxyError('Grok reported a rate limit', 429, 'rate_limit_exceeded', retryAfter(result.retry));
  if (result.status === 401) return false;
  if (result.status !== 200) throw new ProxyError('Could not verify the Grok session', 502, 'session_unavailable');
  if (result.authenticated === null) throw new ProxyError('Grok returned an unrecognized session format; the account was not marked signed out', 502, 'session_schema_unsupported');
  return result.authenticated === true;
}

export async function authenticatedPage(context, options = {}) {
  let lastError;
  for (const page of [...context.pages()].reverse()) {
    if (page.isClosed()) continue;
    try {
      if (new URL(page.url()).origin !== 'https://grok.com') continue;
      if (await authenticated(page, options)) return page;
    } catch (error) {
      if (['rate_limit_exceeded', 'session_check_timeout', 'cancelled'].includes(error.code)) throw error;
      if (page.isClosed()) continue;
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}
