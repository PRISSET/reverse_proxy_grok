import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { sendGatewayRequest } from '../src/gateway-request.mjs';
import { discoverCastle, prepareCastle } from '../src/castle-provider.mjs';
import { evaluateMain } from '../src/browser-evaluate.mjs';
import { makeWorker } from '../src/worker.mjs';
import { Store } from '../src/store.mjs';
import { Exchange } from '../src/exchange.mjs';

test('actual channel placement and standard text events produce an answer, reasoning stays private', async () => {
  const output = [];
  const exchange = new Exchange(delta => output.push(delta), ['response.done']);
  exchange.sent(JSON.stringify({ event: { type: 'response.create', castle_request_token: 'gateway-fixture-token-1' } }));
  exchange.received(JSON.stringify({ event: { type: 'response.chunk', chunk: { text: { channel: 'CHANNEL_ASSISTANT_NOTETAKER_HEADER', text: 'private' } } } }));
  exchange.received(JSON.stringify({ event: { type: 'response.chunk', chunk: { text: { channel: 'CHANNEL_ASSISTANT_RESPONSE', text: 'hello' } } } }));
  exchange.received(JSON.stringify({ event: { type: 'response.output_text.done', text: 'hello world' } }));
  exchange.received(JSON.stringify({ event: { type: 'response.done' } }));
  assert.equal(await exchange.promise, 'hello world');
  assert.deepEqual(output, ['hello', ' world']);
});

test('terminal assistant output is emitted when the server sends no deltas', async () => {
  const exchange = new Exchange(() => {}, ['response.done']);
  exchange.sent(JSON.stringify({ type: 'response.create', castle_request_token: 'gateway-fixture-token-2' }));
  exchange.received(JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [
    { type: 'reasoning', content: [{ type: 'output_text', text: 'private' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'visible' }] },
  ] } }));
  assert.equal(await exchange.promise, 'visible');
});

async function gatewayFixture({ images = [], httpStatus = 200, handshakeError = null } = {}) {
  const sent = [], requests = [];
  let socket, minted = 0;
  class Socket {
    static OPEN = 1;
    constructor(url) {
      this.url = url; this.readyState = 0; socket = this;
      queueMicrotask(() => { this.readyState = 1; this.onopen(); });
    }
    send(raw) {
      const packet = JSON.parse(raw); sent.push(packet);
      if (packet.event.type === 'session.create') queueMicrotask(() => {
        if (handshakeError) return this.onmessage({ data: JSON.stringify({ event: { type: 'error', error: handshakeError } }) });
        this.onmessage({ data: JSON.stringify({ session_id: 'conversation-fixture', event: { type: 'session.created' } }) });
        this.onmessage({ data: JSON.stringify({ session_id: 'conversation-fixture', event: { type: 'conversation.attached', conversation: { id: 'conversation-fixture' } } }) });
      });
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const result = await vm.runInNewContext(`(${sendGatewayRequest})(${JSON.stringify({
    prompt: 'hello', images, eventId: 'evt-fixture', mode: 'fast', timeout: 1000,
  })})`, {
    location: { origin: 'https://grok.com' }, WebSocket: Socket,
    __grokProxyMint: async () => { minted++; return 'test-minted-token'; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { status: httpStatus, ok: httpStatus === 200, headers: { get: () => '12' }, json: async () => url === '/api/auth/session'
        ? { status: 'authenticated', session: { userId: 'fixture-user' } }
        : { fileMetadata: { fileMetadataId: `file-${requests.length}` } } };
    },
    atob, Uint8Array, Blob, FormData, AbortSignal,
    crypto: { randomUUID }, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  socket?.close();
  return { result, sent, requests, socket, minted };
}

test('direct gateway creates session and sends a fresh-token response.create, without DOM interactions', async () => {
  const fixture = await gatewayFixture();
  assert.equal(fixture.result.ok, true);
  assert.equal(fixture.minted, 1);
  assert.match(fixture.socket.url, /^wss:\/\/grok.com\/ws\/mgw\/\?uid=fixture-user$/);
  assert.deepEqual(fixture.sent.map(packet => packet.event.type), ['session.create', 'response.create']);
  assert.equal(fixture.sent[1].session_id, 'conversation-fixture');
  assert.equal(fixture.sent[1].event.item.x_grok.input_chunks[0].text.text, 'hello');
  assert.equal(fixture.sent[1].event.castle_request_token, 'test-minted-token');
});

test('multiple images are uploaded by HTTP and referenced in the same WebSocket turn', async () => {
  const image = { name: 'one.png', mimeType: 'image/png', base64: Buffer.from('image-data').toString('base64') };
  const fixture = await gatewayFixture({ images: [image, { ...image, name: 'two.png' }] });
  assert.equal(fixture.result.ok, true);
  const uploads = fixture.requests.filter(request => request.url === '/http/upload-file-v2/direct');
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].options.method, 'POST');
  assert.equal(uploads[0].options.body.get('file').name, 'one.png');
  const item = fixture.sent[1].event.item;
  assert.deepEqual(item.file_attachment_ids, ['file-2', 'file-3']);
  assert.equal(item.x_grok.input_chunks[1].mention.file_mention.file_id, 'file-3');
});

test('HTTP and handshake limits are reported explicitly without a generation', async () => {
  for (const fixture of [await gatewayFixture({ httpStatus: 429 }), await gatewayFixture({ handshakeError: { code: 'RESOURCE_EXHAUSTED', retry_after: 7 } })]) {
    assert.equal(fixture.result.code, 'rate_limit_exceeded');
    assert.equal(fixture.minted, 0);
    assert.ok(!fixture.sent.some(packet => packet.event.type === 'response.create'));
  }
});

test('Castle discovery selects the initialized SDK provider and invokes the chat flow', async () => {
  const context = vm.createContext({ document: { querySelectorAll: () => [] } });
  vm.runInContext(`
    const provider = { createRequestToken: async function(options) {
      const type = 'mint_start'; const operation = 'createRequestToken';
      return options.method + ':' + type + ':' + operation;
    }};
    const root = { memoizedProps: { value: provider }, return: null };
    document.querySelectorAll = () => [{ __reactFiber$fixture: root }];
  `, context);
  assert.equal(vm.runInContext(`(${discoverCastle})()`, context), true);
  assert.equal(await vm.runInContext('__grokProxyMint()', context), 'chat:mint_start:createRequestToken');
});

test('worker always launches headless and invokes only the request transport, never a composer', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grok-worker-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root); await store.init(); await store.save({ id: 'first', status: 'ready' });
  const context = new EventEmitter(), page = new EventEmitter(), socket = new EventEmitter();
  context.pages = () => [page]; context.cookies = async () => []; context.close = async () => context.emit('close');
  page.goto = async () => {};
  socket.url = () => 'wss://grok.com/ws/mgw/?uid=fixture';
  page.evaluate = async (fn, args, options, isolated) => {
    assert.equal(fn, sendGatewayRequest); assert.equal(options, undefined); assert.equal(isolated, false);
    page.emit('websocket', socket);
    socket.emit('framesent', { payload: JSON.stringify({ event: { type: 'response.create', event_id: args.eventId, castle_request_token: 'gateway-fixture-token-worker' } }) });
    socket.emit('framereceived', { payload: JSON.stringify({ event: { type: 'response.chunk', chunk: { text: { channel: 'CHANNEL_ASSISTANT_RESPONSE', text: 'answer' } } } }) });
    socket.emit('framereceived', { payload: JSON.stringify({ event: { type: 'response.done' } }) });
    return { ok: true };
  };
  const worker = makeWorker(store, { timeout: 1000, headless: false, doneEvents: ['response.done'] }, {
    launch: async (_store, _id, _config, headless) => { assert.equal(headless, true); return context; }, castle: async () => {},
  });
  const result = await worker({ id: 'first' }, { prompt: 'hello', images: [], model: 'grok-web' }, () => {});
  assert.equal(result.text, 'answer');
});

test('main-world helper matches installed Patchright options/isolatedContext argument positions', async () => {
  const page = {
    evaluate: async function(callback, arg, options, isolatedContext = true) {
      if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
        throw new Error('Too many arguments. If you need to pass more than 1 argument to the function wrap them in an object.');
      }
      assert.equal(arguments.length, 4);
      assert.equal(isolatedContext, false);
      return callback === discoverCastle ? true : callback(arg);
    },
  };
  await assert.rejects(page.evaluate(() => {}, undefined, false), /Too many arguments/);
  assert.equal(await evaluateMain(page, value => value + 1, 3), 4);
  await prepareCastle(page, undefined, { timeout: 500 });
});

test('worker reports safe error stages without leaking driver exception details', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'grok-worker-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root); await store.init(); await store.save({ id: 'first', status: 'ready' });
  for (const stage of ['navigation', 'castle', 'gateway']) {
    const context = new EventEmitter(), page = new EventEmitter();
    const exception = () => { throw new Error('private-cookie=secret; private-prompt=secret'); };
    page.goto = async () => { if (stage === 'navigation') exception(); };
    page.evaluate = async () => exception();
    context.pages = () => [page]; context.cookies = async () => []; context.close = async () => context.emit('close');
    const worker = makeWorker(store, { timeout: 1000, doneEvents: ['response.done'] }, {
      launch: async () => context, castle: async () => { if (stage === 'castle') exception(); },
    });
    await assert.rejects(worker({ id: 'first' }, { prompt: 'hello', images: [], model: 'grok-web' }, () => {}), error => {
      assert.equal(error.stage, stage);
      assert.doesNotMatch(error.message, /private-cookie|private-prompt|secret/);
      return true;
    });
  }
});
