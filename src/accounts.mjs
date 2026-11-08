import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from './config.mjs';
import { Store, accountId } from './store.mjs';
import { ProxyError } from './errors.mjs';
import { loginAccount } from './account-login.mjs';
import { recoverLock } from './lock-recovery.mjs';

process.umask(0o077);
const store = new Store(config.stateDir);
await store.init();
const [command, ...ids] = process.argv.slice(2);

async function main() {
  if (command === 'list') {
    for (const account of await store.list()) {
      console.log(`${account.id}\t${account.status}\t${account.cooldownUntil ? new Date(account.cooldownUntil).toISOString() : '-'}`);
    }
    return;
  }
  if (command === 'recover' && ids.length) {
    ids.forEach(accountId);
    for (const id of ids) {
      const recovered = await recoverLock(store, id);
      console.log(`[${id}] ${recovered ? 'Старая блокировка снята. Профиль и cookies сохранены.' : 'Блокировки нет.'}`);
    }
    return;
  }
  if (command !== 'login' || !ids.length) {
    console.log('Usage: npm run accounts -- login account1 account2 ...\n       npm run accounts -- list\n       npm run accounts -- recover account3');
    process.exitCode = command ? 1 : 0;
    return;
  }
  ids.forEach(accountId);
  if (new Set(ids).size !== ids.length) throw new Error('Account IDs must be distinct');
  if (!stdin.isTTY) throw new Error('Interactive terminal required');
  const terminal = createInterface({ input: stdin, output: stdout });
  const cancel = new AbortController();
  const stop = () => {
    if (cancel.signal.aborted) {
      console.error('Повторная отмена: завершаю процесс. Если Chrome остался открыт, закройте его перед recover.');
      process.exit(130);
    }
    console.log('\nОтмена: закрываю Chrome (до 10 секунд)…');
    cancel.abort();
  };
  terminal.on('SIGINT', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    for (const id of ids) await loginAccount(store, id, terminal, cancel.signal, config);
    console.log(`Готово: сохранено аккаунтов ${ids.length}. Каталог: ${config.stateDir}/accounts`);
  }
  finally {
    terminal.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

try { await main(); }
catch (error) {
  console.error(error instanceof ProxyError
    ? error.message : 'Операция прервана или не завершена. Ранее сохранённые сессии не удалены.');
  process.exitCode = 1;
}
// A stalled browser transport must not keep the CLI alive after bounded cleanup.
process.exit(process.exitCode || 0);
