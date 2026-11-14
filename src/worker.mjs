import { randomUUID } from 'node:crypto';
import { openBrowser } from './browser.mjs';
import { ProxyError, checkAbort, aborted } from './errors.mjs';
import { frame } from './protocol.mjs';
import { Exchange } from './exchange.mjs';
import { browserCloser } from './sessions.mjs';
import { prepareCastle } from './castle-provider.mjs';
import { sendGatewayRequest } from './gateway-request.mjs';
import { bounded } from './deadline.mjs';
import { evaluateMain } from './browser-evaluate.mjs';

const messages = {
  auth_required: 'Account needs login', rate_limit_exceeded: 'Grok reported a rate limit',
  castle_sdk_unavailable: 'Grok Castle SDK is unavailable in the background context',
  castle_token_missing: 'Grok Castle SDK did not return a fresh token',
  upload_failed: 'Grok rejected the image upload', upload_timeout: 'Image processing timed out',
  gateway_handshake_timeout: 'Grok WebSocket session handshake timed out',
  connection_closed: 'Grok WebSocket connection failed', protocol_error: 'Unsupported Grok protocol response',
  upstream_http_error: 'Grok HTTP request failed', upstream_error: 'Grok rejected the request',
};

function stageFailure(error, stage) {
  if (error instanceof ProxyError) { error.stage = stage; return error; }
  const detail = typeof error?.message === 'string' ? error.message : '';
  let code, message;
  if (detail.includes('Too many arguments')) {
    code = 'browser_api_mismatch'; message = 'Background browser API arguments are incompatible with the installed driver';
  } else if (/Execution context was destroyed|Target.*closed|page.*closed|context.*closed/i.test(detail)) {
    code = 'browser_context_closed'; message = 'Background browser context closed or navigated during the request';
  } else {
    [code, message] = {
      navigation: ['navigation_failed', 'Could not load Grok in the background context'],
      castle: ['castle_discovery_failed', 'Could not access the Grok Castle provider'],
      gateway: ['gateway_evaluation_failed', 'Could not execute the background HTTP/WebSocket transport'],
      response: ['browser_operation_failed', 'Could not read the background Grok response'],
    }[stage] || ['browser_operation_failed', 'Background browser operation failed'];
  }
  const result = new ProxyError(`${message} (stage: ${stage})`, 502, code);
  result.stage = stage;
  return result;
}

export function makeWorker(store, config, { launch = openBrowser, castle = prepareCastle } = {}) {
  return async (account, input, onDelta, signal) => {
    checkAbort(signal);
    // Visible Chrome is only for login; generation is headless and never touches the composer.
    const context = await launch(store, account.id, config, true);
    const closeBrowser = browserCloser(store, account.id, context);
    const deadline = AbortSignal.timeout(config.timeout);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const exchange = new Exchange(onDelta, config.doneEvents);
    const eventId = `evt_resp_${randomUUID()}`;
    let stage = 'navigation';
    const cancel = () => {
      exchange.fail(signal?.aborted ? aborted() : new ProxyError('Grok request timed out', 504, 'upstream_timeout'));
      void closeBrowser().catch(() => {});
    };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      checkAbort(combined);
      const page = context.pages()[0] || await context.newPage();
      page.on('websocket', socket => {
        if (!socket.url().startsWith('wss://grok.com/ws/mgw/')) return;
        let selected = false;
        socket.on('framesent', ({ payload }) => {
          if (frame(payload)?.event_id !== eventId) return;
          selected = true; exchange.sent(payload);
        });
        socket.on('framereceived', ({ payload }) => { if (selected) exchange.received(payload); });
        socket.on('close', () => {
          if (selected) exchange.fail(new ProxyError('Grok connection closed before completion', 502, 'connection_closed'));
        });
      });
      await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      stage = 'castle';
      await castle(page, combined);
      stage = 'gateway';
      const result = await bounded(() => evaluateMain(page, sendGatewayRequest, {
        prompt: input.prompt,
        images: input.images.map(image => ({ name: image.name, mimeType: image.mimeType, base64: image.buffer.toString('base64') })),
        eventId, mode: config.grokMode || 'auto', timeout: config.timeout,
      }), { timeout: config.timeout, signal: combined, code: 'upstream_timeout', message: 'Grok request preparation timed out' });
      if (!result?.ok) {
        const code = Object.hasOwn(messages, result?.code) ? result.code : 'upstream_error';
        throw new ProxyError(messages[code], result?.status || 502, code, result?.retryAfter ?? null);
      }
      stage = 'response';
      return { text: await exchange.promise, model: input.model };
    } catch (error) {
      if (signal?.aborted) throw aborted();
      if (deadline.aborted) throw new ProxyError('Grok request timed out', 504, 'upstream_timeout');
      throw stageFailure(error, stage);
    } finally {
      combined.removeEventListener('abort', cancel);
      await closeBrowser();
    }
  };
}
