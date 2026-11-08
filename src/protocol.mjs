import { ProxyError } from './errors.mjs';

export function envelope(payload) {
  try {
    const parsed = JSON.parse(String(payload));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

export function frame(payload) {
  const parsed = envelope(payload);
  return parsed?.event && typeof parsed.event === 'object' ? parsed.event : parsed;
}

export function upstreamError(event) {
  if (!event) return null;
  const error = event.error || (event.type === 'error' ? event : null);
  if (!error) return null;
  const code = String(error.code ?? error.status ?? '').toUpperCase();
  if (['429', 'RATE_LIMIT_EXCEEDED', 'RATE_LIMITED', 'RESOURCE_EXHAUSTED'].includes(code)) {
    const seconds = Number(error.retry_after ?? error.retryAfter);
    return new ProxyError('Grok reported a rate limit', 429, 'rate_limit_exceeded', Number.isFinite(seconds) && seconds > 0 ? seconds : null);
  }
  if (['401', 'UNAUTHENTICATED', 'AUTH_REQUIRED'].includes(code)) return new ProxyError('Account needs login', 401, 'auth_required');
  return new ProxyError('Grok rejected the request; inspect the page without exporting secrets', 502, 'upstream_error');
}

export function textChunk(event) {
  if (!event) return '';
  const info = event.chunk?.text;
  const channel = info?.channel ?? event.chunk?.channel ?? event.channel ?? event.x_grok?.channel;
  if (channel && channel !== 'CHANNEL_ASSISTANT_RESPONSE') return '';
  if (event.x_grok?.is_thinking || event.x_grok?.isThinking) return '';
  if (event.type === 'response.chunk') return channel === 'CHANNEL_ASSISTANT_RESPONSE' && typeof info?.text === 'string' ? info.text : '';
  if (event.type === 'response.output_text.delta') return typeof event.delta === 'string' ? event.delta : '';
  return '';
}

export function completedText(event) {
  if (event?.type === 'response.output_text.done') {
    const channel = event.channel ?? event.x_grok?.channel;
    if (channel && channel !== 'CHANNEL_ASSISTANT_RESPONSE') return '';
    if (event.x_grok?.is_thinking || event.x_grok?.isThinking) return '';
    return typeof event.text === 'string' ? event.text : '';
  }
  const output = event?.response?.output;
  if (!Array.isArray(output)) return '';
  return output.filter(item => item?.type === 'message' && item.role === 'assistant'
      && (!item.channel || item.channel === 'CHANNEL_ASSISTANT_RESPONSE'))
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .filter(part => part.type === 'output_text' && (!part.channel || part.channel === 'CHANNEL_ASSISTANT_RESPONSE'))
    .map(part => typeof part.text === 'string' ? part.text : '').join('');
}

export function retryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.max(1, Math.ceil(numeric));
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(1, Math.ceil((time - now) / 1000)) : null;
}
