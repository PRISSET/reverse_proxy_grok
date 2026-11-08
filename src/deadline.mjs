import { ProxyError, aborted } from './errors.mjs';

export function bounded(operation, { timeout = 15000, code = 'operation_timeout', message = 'Operation timed out', signal } = {}) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, aborted());
    const timer = setTimeout(() => finish(reject, new ProxyError(message, 504, code)), timeout);
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => settled ? undefined : operation()).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
