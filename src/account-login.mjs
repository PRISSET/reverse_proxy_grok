import { openBrowser, authenticatedPage } from './browser.mjs';
import { browserCloser, saveSessionCookies } from './sessions.mjs';
import { bounded } from './deadline.mjs';

export async function loginAccount(store, id, terminal, signal, config, {
  launch = openBrowser, verify = authenticatedPage, log = console.log,
  checkTimeout = 20000, cookieTimeout = 10000, closeTimeout = 10000,
} = {}) {
  const unlock = await store.lock(id);
  let context;
  let closeBrowser;
  let cancel;
  let saved = false;
  let failure;
  try {
    log(`[${id}] Открываю отдельный профиль Chrome…`);
    context = await launch(store, id, config, false);
    closeBrowser = browserCloser(store, id, context, { timeout: closeTimeout, save: false });
    cancel = () => { void closeBrowser().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    signal.throwIfAborted();
    const page = context.pages()[0] || await context.newPage();
    await bounded(() => page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }), {
      timeout: 46000, signal, code: 'navigation_timeout', message: 'Grok page did not open within 45 seconds',
    });
    while (true) {
      await terminal.question(`[${id}] Войдите в Grok. Enter — проверить и сохранить (Ctrl+C — отмена): `, { signal });
      log(`[${id}] Проверяю авторизацию (до 20 секунд)…`);
      try {
        if (await bounded(() => verify(context, { signal }), {
          timeout: checkTimeout, signal, code: 'session_check_timeout', message: 'Session check exceeded 20 seconds. Retry login for this account',
        })) break;
      } catch (error) {
        if (['session_unavailable', 'session_schema_unsupported', 'rate_limit_exceeded'].includes(error.code)) {
          log(`[${id}] ${error.message}. Повторите проверку через Enter.`);
          continue;
        }
        throw error;
      }
      log(`[${id}] Вход пока не подтверждён. Завершите вход в открытом Chrome.`);
    }
    log(`[${id}] Вход подтверждён. Сохраняю сессию (до 10 секунд)…`);
    await saveSessionCookies(store, id, context, { timeout: cookieTimeout, signal });
    await store.save({ id, status: 'ready', authorizedAt: new Date().toISOString(), cooldownUntil: 0 });
    saved = true;
    log(`[${id}] СОХРАНЕНО: профиль и сессионные cookies записаны. Закрываю Chrome (до 10 секунд)…`);
  } catch (error) {
    failure = error;
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel);
    try { await closeBrowser?.(); }
    catch (error) {
      failure ||= error;
      log(`[${id}] ${error.message}. ${saved ? 'Подтверждённая сессия уже сохранена.' : 'Старые сохранённые данные не удалены.'}`);
    }
    // Do not make a still-open profile available to another process.
    if (!context || closeBrowser?.closed) await unlock();
    else log(`[${id}] Блокировка оставлена: закройте Chrome и выполните accounts -- recover ${id}.`);
  }
  if (failure) throw failure;
  log(`[${id}] Готово: сессия сохранена, Chrome закрыт.`);
}
