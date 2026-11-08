export class ProxyError extends Error {
  constructor(message, status = 502, code = 'upstream_error', retryAfter = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const aborted = () => new ProxyError('Request cancelled', 499, 'cancelled');
export function checkAbort(signal) {
  if (signal?.aborted) throw aborted();
}
