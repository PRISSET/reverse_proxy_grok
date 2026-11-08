import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalize } from './input.mjs';
import { ProxyError } from './errors.mjs';

function json(res, status, body, retry = null) {
  if (retry != null) res.setHeader('Retry-After', String(retry));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(req, key) {
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(req.headers.authorization || ''), digest(`Bearer ${key}`));
}

async function readBody(req, limit) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new ProxyError('Use Content-Type: application/json', 415, 'invalid_request_error');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ProxyError('Request body is too large', 413, 'invalid_request_error');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProxyError('Invalid JSON', 400, 'invalid_request_error'); }
}

function responseObject(id, itemId, text, status = 'completed') {
  return {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model: 'grok-web',
    output: status === 'in_progress' ? [] : [{
      id: itemId, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    error: null, incomplete_details: null,
  };
}

function streamer(res, responses, id, itemId, created) {
  let started = false;
  let sequence = 0;
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
  const chat = (delta, finish = null) => res.write(`data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model: 'grok-web',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`);
  const start = () => {
    if (started) return;
    started = true;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' });
    if (responses) {
      const response = responseObject(id, itemId, '', 'in_progress');
      event('response.created', { response });
      event('response.in_progress', { response });
      event('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      event('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    } else chat({ role: 'assistant', content: '' });
  };
  return {
    delta(text) {
      if (res.destroyed) throw new ProxyError('Client disconnected', 499, 'cancelled');
      start();
      if (responses) event('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: text });
      else chat({ content: text });
      if (res.writableLength > 4 * 1024 * 1024) throw new ProxyError('Client is reading too slowly', 499, 'cancelled');
    },
    done(text) {
      start();
      if (responses) {
        const response = responseObject(id, itemId, text);
        event('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text });
        event('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: response.output[0].content[0] });
        event('response.output_item.done', { output_index: 0, item: response.output[0] });
        event('response.completed', { response });
      } else { chat({}, 'stop'); res.write('data: [DONE]\n\n'); }
      res.end();
    },
    error(error) {
      if (responses) event('error', { code: error.code, message: error.message });
      else res.write(`data: ${JSON.stringify({ error: { message: error.message, type: error.code } })}\n\n`);
      res.end();
    },
  };
}

export function createProxyHandler({ pool, key, config, audit }) {
  return async (req, res) => {
    const cancel = new AbortController();
    res.on('close', () => { if (!res.writableEnded) cancel.abort(); });
    let stream;
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });
      if (!authorized(req, key)) throw new ProxyError('Invalid proxy API key', 401, 'authentication_error');
      if (req.method === 'GET' && path === '/log.json') {
        if (!audit) throw new ProxyError('Audit log unavailable', 503, 'log_unavailable');
        const after = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('after') || 0);
        return json(res, 200, audit.snapshot(Number.isSafeInteger(after) && after >= 0 ? after : 0));
      }
      if (req.method === 'GET' && path === '/status') return json(res, 200, { accounts: await pool.status() });
      if (req.method === 'GET' && ['/models', '/v1/models'].includes(path)) {
        return json(res, 200, { object: 'list', data: [{ id: 'grok-web', object: 'model', created: 0, owned_by: 'local-browser-bridge' }] });
      }
      const responses = ['/responses', '/v1/responses'].includes(path);
      if (req.method !== 'POST' || (!responses && !['/chat/completions', '/v1/chat/completions'].includes(path))) {
        throw new ProxyError('Route not found', 404, 'not_found');
      }
      const input = normalize(await readBody(req, config.maxBody), config, responses);
      const id = `${responses ? 'resp' : 'chatcmpl'}_${randomUUID().replaceAll('-', '')}`;
      const itemId = `msg_${randomUUID().replaceAll('-', '')}`;
      const created = Math.floor(Date.now() / 1000);
      const supplied = req.headers['x-request-id'];
      const requestId = typeof supplied === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(supplied) ? supplied : randomUUID();
      res.setHeader('X-Request-Id', requestId);
      if (input.stream) stream = streamer(res, responses, id, itemId, created);
      const result = await pool.execute(input, delta => stream?.delta(delta), cancel.signal,
        { requestId, strategy: 'round_robin' });
      if (input.stream) return stream.done(result.text);
      if (responses) return json(res, 200, responseObject(id, itemId, result.text));
      json(res, 200, {
        id, object: 'chat.completion', created, model: 'grok-web',
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      });
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const safe = error instanceof ProxyError ? error : new ProxyError('Internal proxy error', 500, 'internal_error');
      if (res.headersSent) stream?.error(safe);
      else json(res, safe.status, { error: { message: safe.message, type: safe.code, code: safe.code } }, safe.retryAfter);
    }
  };
}

export function createProxyServer(options) {
  return http.createServer({ requestTimeout: 30000, headersTimeout: 10000 }, createProxyHandler(options));
}
