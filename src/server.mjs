import { config } from './config.mjs';
import { Store } from './store.mjs';
import { AccountPool } from './pool.mjs';
import { makeWorker } from './worker.mjs';
import { createProxyServer } from './api.mjs';
import { AuditLog } from './audit.mjs';

process.umask(0o077);
const store = new Store(config.stateDir);
await store.init();
const key = await store.apiKey();
const audit = new AuditLog(config.logFile);
await audit.init();
const shutdown = new AbortController();
const worker = makeWorker(store, config);
const pool = new AccountPool(store, (account, input, delta, signal) => worker(
  account, input, delta, AbortSignal.any([signal, shutdown.signal]),
), { ...config, audit: event => audit.record(event) });
const server = createProxyServer({ pool, key, config, audit });
server.on('error', error => {
  console.error(`[proxy] Server could not listen (${error.code || 'unknown'})`);
  process.exitCode = 1;
});
server.listen(config.port, config.host, () => {
  console.log(`[proxy] http://${config.host}:${config.port}/v1`);
  console.log(`[proxy] Журнал: ${config.logFile}`);
  console.log(`[proxy] API key: ${process.env.GROK_PROXY_KEY ? 'environment' : `${config.stateDir}/api-key`}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    shutdown.abort();
    server.close();
    server.closeIdleConnections();
  });
}
