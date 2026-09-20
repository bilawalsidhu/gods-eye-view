import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { handleHudSummary } from '../../server/providers/ollama/hud-summary.js';

function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: 'POST', url: '/', headers: {} });
  return req;
}

function response() {
  const res = new EventEmitter();
  const headers = {};
  res.statusCode = 200;
  res.writableEnded = false;
  res.setHeader = (k, v) => (headers[k.toLowerCase()] = v);
  res.done = new Promise((resolve) => {
    res.end = (value) => {
      res.writableEnded = true;
      resolve({ status: res.statusCode, headers, body: JSON.parse(value) });
    };
  });
  return res;
}

test('HUD summary normalizes the local reply to five words and sends keep_alive', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('handler must use the injected fetch');
  });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/api/show'))
      return Response.json({ capabilities: ['completion', 'tools'] });
    return Response.json({
      message: { content: 'Downtown Austin, Congress Avenue, flights on now.' },
    });
  };
  const res = response();
  await handleHudSummary(
    request({ place: 'Downtown Austin' }),
    res,
    { fetchImpl },
  );
  const result = await res.done;
  assert.equal(result.status, 200);
  assert.equal(result.body.summary.split(' ').length, 5);
  const chat = calls.find((c) => c.url.endsWith('/api/chat'));
  assert.equal(chat.body.keep_alive, process.env.OLLAMA_KEEP_ALIVE || '30m');
  assert.equal(chat.body.think, undefined, 'no think flag for a non-thinking model');
});

test('a client that disconnects cancels the upstream Ollama request', async () => {
  let upstreamSignal;
  const fetchImpl = (url, options) => {
    if (url.endsWith('/api/show')) return Response.json({ capabilities: [] });
    upstreamSignal = options.signal;
    return new Promise((_, reject) =>
      options.signal.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      ),
    );
  };
  const res = response();
  const pending = handleHudSummary(request({}), res, { fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 10));
  res.emit('close');
  await pending;
  const result = await res.done;
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(result.status, 499);
});

test('a completed response does not abort anything on close', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/api/show')
      ? Response.json({ capabilities: [] })
      : Response.json({ message: { content: 'One two three four five' } });
  const res = response();
  await handleHudSummary(request({}), res, { fetchImpl });
  const result = await res.done;
  assert.equal(result.status, 200);
  assert.doesNotThrow(() => res.emit('close'));
});
