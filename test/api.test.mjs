import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxyHandler } from '../src/api.mjs';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { config } from '../src/config.mjs';
import { ProxyError } from '../src/errors.mjs';

async function fixture(t, execute, audit) {
  const handler = createProxyHandler({ key: 'test-key', config, pool: {
    status: async () => [{ id: 'first', status: 'ready' }], execute,
  }, audit });
  return async (route, body, key = 'test-key', extraHeaders = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = body === undefined ? 'GET' : 'POST';
    req.url = route;
    req.headers = { host: '127.0.0.1:8787', authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extraHeaders };
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = new EventEmitter();
    const headers = new Headers();
    const output = [];
    let status = 200;
    res.writableLength = 0;
    res.setHeader = (key, value) => headers.set(key, value);
    res.writeHead = (code, values) => {
      status = code;
      res.headersSent = true;
      for (const [key, value] of Object.entries(values)) headers.set(key, value);
    };
    res.write = value => { output.push(value); return true; };
    res.end = value => { if (value) output.push(value); res.writableEnded = true; };
    await handler(req, res);
    return new Response(output.join(''), { status, headers });
  };
}

test('HTTP authentication and nonstream response', async t => {
  const request = await fixture(t, async () => ({ text: 'hello' }));
  assert.equal((await request('/v1/models', undefined, 'wrong')).status, 401);
  const models = await (await request('/v1/models')).json();
  assert.equal(models.data[0].id, 'grok-web');
  const response = await request('/v1/chat/completions', { messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'hello');
});

test('Chat SSE includes deltas and stop only on success', async t => {
  const request = await fixture(t, async (_input, emit) => {
    emit('one'); emit('two'); return { text: 'onetwo' };
  });
  const response = await request('/v1/chat/completions', { messages: [{ role: 'user', content: 'Hi' }], stream: true });
  const text = await response.text();
  assert.match(text, /"content":"one"/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]/);
});

test('Responses SSE has ordered events, completed object and identical text', async t => {
  const request = await fixture(t, async (_input, emit) => {
    emit('yes'); return { text: 'yes' };
  });
  const response = await request('/v1/responses', { input: 'Hi', stream: true });
  const text = await response.text();
  const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  assert.equal(events[0].type, 'response.created');
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.at(-1).response.output[0].content[0].text, 'yes');
  events.forEach((event, index) => assert.equal(event.sequence_number, index));
});

test('429 before stream start stays HTTP 429; partial stream ends with error', async t => {
  let partial = false;
  const request = await fixture(t, async (_input, emit) => {
    if (partial) emit('part');
    throw new ProxyError('limited', 429, 'rate_limit_exceeded', 7);
  });
  const body = { messages: [{ role: 'user', content: 'Hi' }], stream: true };
  const response = await request('/v1/chat/completions', body);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '7');
  partial = true;
  const text = await (await request('/v1/chat/completions', body)).text();
  assert.match(text, /"error"/);
  assert.doesNotMatch(text, /\[DONE\]|"finish_reason":"stop"/);
});

test('unsupported functionality is rejected instead of silently ignored', async t => {
  const request = await fixture(t, () => assert.fail('must not execute'));
  assert.equal((await request('/v1/responses', { input: 'Hi', tools: [{}] })).status, 400);
  assert.equal((await request('/v1/responses', { input: 'Hi', previous_response_id: 'old' })).status, 400);
});

test('log endpoint requires proxy authentication and supports incremental reads', async t => {
  const request = await fixture(t, async () => ({}), { snapshot: after => ({ version: 1, last_sequence: 7, events: after < 7 ? [{ sequence: 7 }] : [] }) });
  assert.equal((await request('/log.json', undefined, 'wrong')).status, 401);
  const log = await (await request('/log.json?after=6')).json();
  assert.equal(log.events[0].sequence, 7);
  assert.equal((await (await request('/log.json?after=7')).json()).events.length, 0);
});

test('web chat and browser-session endpoints have been removed', async t => {
  const request = await fixture(t, () => assert.fail('removed routes must not execute a worker'));
  for (const route of ['/', '/chat', '/app.js', '/style.css']) {
    assert.equal((await request(route)).status, 404);
  }
  assert.equal((await request('/ui/session', {})).status, 404);
  assert.equal((await request('/ui/chat', { messages: [{ role: 'user', content: 'hello' }] })).status, 404);
  assert.equal((await request('/status', undefined, 'wrong', { cookie: 'grok_local_ui=legacy' })).status, 401);
});

test('standard API preserves request IDs and round-robin routing', async t => {
  let options;
  const request = await fixture(t, async (_input, _emit, _signal, received) => { options = received; return { text: 'ok' }; });
  const response = await request('/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }] }, 'test-key', { 'x-request-id': 'request-fixture-123' });
  assert.equal(response.status, 200);
  assert.equal(options.strategy, 'round_robin');
  assert.equal(options.requestId, 'request-fixture-123');
  assert.equal(response.headers.get('x-request-id'), 'request-fixture-123');
});
