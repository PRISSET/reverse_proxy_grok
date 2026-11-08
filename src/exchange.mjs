import { createHash } from 'node:crypto';
import { ProxyError, aborted } from './errors.mjs';
import { envelope, frame, textChunk, completedText, upstreamError } from './protocol.mjs';

const seenTokens = new Set();

export class Exchange {
  constructor(onDelta, doneEvents) {
    this.onDelta = onDelta;
    this.doneEvents = doneEvents;
    this.started = false;
    this.finished = false;
    this.text = '';
    this.types = new Set();
    this.promise = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // UI work may fail before the caller reaches the await below.
    this.promise.catch(() => {});
  }
  fail(error) {
    if (this.finished) return;
    this.finished = true;
    this.reject(error);
  }
  sent(payload) {
    const event = frame(payload);
    if (event?.type !== 'response.create' || this.finished) return;
    if (this.started) return this.fail(new ProxyError('Unexpected second generation in the page', 502, 'protocol_error'));
    const token = event.castle_request_token;
    if (typeof token !== 'string' || !token) return this.fail(new ProxyError('Page did not supply a Castle token', 502, 'castle_token_missing'));
    const hash = createHash('sha256').update(token).digest('hex');
    if (seenTokens.has(hash)) return this.fail(new ProxyError('Page reused a Castle token', 502, 'castle_token_reused'));
    seenTokens.add(hash);
    if (seenTokens.size > 1024) seenTokens.delete(seenTokens.values().next().value);
    this.started = true;
    this.sessionId = envelope(payload)?.session_id || event.session_id;
  }
  received(payload) {
    if (!this.started || this.finished) return;
    const event = frame(payload);
    if (!event) return;
    const sessionId = envelope(payload)?.session_id || event.session_id;
    if (this.sessionId && sessionId && this.sessionId !== sessionId) return;
    const responseId = event.response_id || event.response?.id;
    if (this.responseId && responseId && this.responseId !== responseId) return;
    if (event.type === 'response.created' && responseId) this.responseId = responseId;
    if (typeof event.type === 'string' && this.types.size < 100) this.types.add(event.type.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 100));
    const error = upstreamError(event) || (event.response?.error ? upstreamError({ error: event.response.error }) : null);
    if (error) return this.fail(error);
    let delta = textChunk(event);
    if (!delta && (event.type === 'response.output_text.done' || this.doneEvents.includes(event.type))) {
      const final = completedText(event);
      if (final && final.startsWith(this.text)) delta = final.slice(this.text.length);
    }
    if (delta) {
      if (this.text.length + delta.length > 8 * 1024 * 1024) {
        return this.fail(new ProxyError('Grok response exceeds the local size limit', 502, 'response_too_large'));
      }
      this.text += delta;
      try { this.onDelta(delta); }
      catch { return this.fail(aborted()); }
    }
    if (this.doneEvents.includes(event.type)) {
      const status = event.response?.status;
      if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
        return this.fail(new ProxyError('Grok generation did not complete', 502, 'incomplete_response'));
      }
      if (!this.text) return this.fail(new ProxyError('Completed response contains no supported text chunks', 502, 'protocol_error'));
      this.finished = true;
      this.resolve(this.text);
    }
  }
}

