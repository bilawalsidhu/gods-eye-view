import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { gbfsProxy, cctvProxy, fetchCctvImageFromUpstream } from '../vite.config.js';
import { FRAME_MAX_BYTES, readResponseBytesCapped, pipeMediaResponse,
  upstreamLifetime } from '../server/proxySafety.mjs';

function sink() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  return Object.assign(res, { chunks, headers: {}, statusCode: 200,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
  });
}
function route(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use(_path, fn) { handler = fn; } } });
  return handler;
}
function request(url) { return Object.assign(new EventEmitter(), { method: 'GET', headers: {}, url }); }
const target = '/' + encodeURIComponent('https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json');

test('GBFS never forwards HTML, malformed JSON, or a redirect response', async () => {
  for (const upstream of [new Response('<script>CANARY</script>', { headers: { 'content-type': 'text/html' } }),
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })]) {
    const handler = route(gbfsProxy({ fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return upstream;
    } }));
    const res = sink();
    await handler(request(target), res);
    assert.equal(res.statusCode, 502);
    assert(!Buffer.concat(res.chunks).toString().includes('CANARY'));
  }
});

test('GBFS validates destinations before fetching and returns a fixed JSON type', async () => {
  let calls = 0;
  const handler = route(gbfsProxy({ fetchImpl: async () => { calls++; return Response.json({ data: { stations: [] } }); } }));
  for (const url of ['https://gbfs.lyft.com:8443/station_status.json',
    'https://user:pass@gbfs.lyft.com/station_status.json', 'https://evil.example/station_status.json']) {
    const res = sink();
    await handler(request('/' + encodeURIComponent(url)), res);
    assert([400, 403].includes(res.statusCode));
  }
  assert.equal(calls, 0);
  const res = sink();
  await handler(request(target), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(Buffer.concat(res.chunks).toString()), { data: { stations: [] } });
});

test('GBFS deadline remains active after headers arrive and cancels a stalled body', async () => {
  let signal;
  const handler = route(gbfsProxy({ timeoutMs: 20, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    } }));
  } }));
  const res = sink();
  await handler(request(target), res);
  assert.equal(res.statusCode, 504);
  assert(signal.aborted);
});

test('body reader cancels both declared and chunked oversized bodies before retaining them', async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const upstream = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(9)); },
      cancel() { cancelled = true; },
    }), { headers: declared ? { 'content-length': '100' } : {} });
    await assert.rejects(readResponseBytesCapped(upstream, 8), /too large/);
    assert(cancelled);
  }
});

test('CCTV image reader rejects and cancels active content and oversized images', async () => {
  for (const type of ['text/html', 'image/svg+xml', 'application/xml', 'image/jpeg']) {
    let cancelled = false;
    const image = await fetchCctvImageFromUpstream('https://camera.example/frame', {
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, 'error');
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
          headers: { 'content-type': type, 'content-length': String(FRAME_MAX_BYTES + 1) },
        });
      },
    });
    assert.equal(image, null);
    assert(cancelled);
  }
});

test('CCTV media route rejects HTML even for a configured video camera', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    return new Response('<script>CANARY</script>', { headers: { 'content-type': 'text/html' } });
  });
  const handler = route(cctvProxy({ getSources: async () => [{ id: 'camera', feedType: 'video', url: 'https://camera.example/live' }] }));
  const res = sink();
  await handler(request('/media/camera'), res);
  assert.equal(res.statusCode, 502);
  assert(!Buffer.concat(res.chunks).toString().includes('CANARY'));
});

test('media pipeline preserves valid video and bounds chunked streams', async () => {
  const res = sink();
  await pipeMediaResponse(res, new Response('video', { headers: { 'content-type': 'video/mp4' } }), { maxBytes: 8 });
  assert.equal(Buffer.concat(res.chunks).toString(), 'video');
  let cancelled = false;
  const oversized = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(9)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'video/mp4' } });
  const bounded = sink();
  await assert.rejects(pipeMediaResponse(bounded, oversized, { maxBytes: 8 }), /size cap/);
  assert(cancelled);
  assert.equal(Buffer.concat(bounded.chunks).length, 0);
  assert(bounded.destroyed);
});

test('client disconnect cancels upstream media and releases lifetime listeners', async () => {
  const req = request('/media/camera');
  const res = sink();
  const lifetime = upstreamLifetime(req, res, 1000);
  let cancelled = false;
  const upstream = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'content-type': 'multipart/x-mixed-replace; boundary=frame' },
  });
  const work = pipeMediaResponse(res, upstream, { signal: lifetime.signal });
  req.emit('aborted');
  await assert.rejects(work, /abort/i);
  assert(cancelled);
  lifetime.dispose();
  assert.equal(req.listenerCount('aborted'), 0);
});
