// cctvMediaRelay: the Node-half guarantees of the dev CCTV media relay —
// an abandoned viewer takes the upstream stream with them, and a feed that
// stalls mid-body cannot hold the connection forever. The Pages twin gets
// both for free from workerd; these tests pin the dev relay's own paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  CCTV_MEDIA_IDLE_TIMEOUT_MS,
  proxyMediaResponse,
  watchDownstreamClose,
} from './cctvMediaRelay.js';

const JPEG_PASSTHROUGH_HEADERS = {
  'content-type': 'image/jpeg',
  'cache-control': 'no-store',
};

/** Minimal stand-in for http.ServerResponse — a real EventEmitter (Node's
 *  pipe/unpipe need the full listener API) with the writable surface. */
function fakeRes() {
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: 200,
    writableEnded: false,
    writableNeedDrain: false,
    writtenHeaders: null,
    chunks: [],
    ended: false,
    writeHead(status, headers) { this.statusCode = status; this.writtenHeaders = headers; },
    write(chunk) { this.chunks.push(chunk); return !this.writableNeedDrain; },
    end() { this.ended = true; this.writableEnded = true; this.emit('close'); },
  });
  return res;
}

/** A live MJPEG-ish body: an endless web ReadableStream the test pushes to. */
function liveBody() {
  let controller = null;
  let cancelled = false;
  const stream = new ReadableStream({
    start(c) { controller = c; },
    cancel() { cancelled = true; },
  });
  return {
    stream,
    push: (chunk) => controller.enqueue(new TextEncoder().encode(chunk)),
    close: () => controller.close(),
    get cancelled() { return cancelled; },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a viewer who leaves mid-stream releases the upstream', async () => {
  const body = liveBody();
  body.push('frame-1');
  const res = fakeRes();
  const done = proxyMediaResponse(res, { status: 200, headers: new Headers(JPEG_PASSTHROUGH_HEADERS), body: body.stream });
  await sleep(10);
  assert.equal(res.statusCode, 200, 'passthrough headers were written');
  assert.ok(res.chunks.length > 0, 'frames flowed to the client');

  res.emit('close');
  await sleep(20);
  assert.ok(body.cancelled, 'the upstream body must be cancelled with the viewer gone');
  assert.equal(res.ended, false, 'an abandoned response is not ended by the relay');
  await done;
});

test('a stalled feed is torn down at the idle deadline', async () => {
  const body = liveBody();
  body.push('frame-1');
  const res = fakeRes();
  const done = proxyMediaResponse(res, { status: 200, headers: new Headers(JPEG_PASSTHROUGH_HEADERS), body: body.stream }, { idleTimeoutMs: 25 });
  await sleep(10);
  assert.equal(res.ended, false, 'silence under the deadline is tolerated');

  await sleep(60);
  assert.ok(body.cancelled, 'the stalled upstream is cancelled at the deadline');
  assert.equal(res.ended, true, 'the client response is closed at the deadline');
  await done;
});

test('bytes from upstream renew the deadline; a paused pipe is a slow client, not a dead camera', async () => {
  const body = liveBody();
  const res = fakeRes();
  const done = proxyMediaResponse(res, { status: 200, headers: new Headers(JPEG_PASSTHROUGH_HEADERS), body: body.stream }, { idleTimeoutMs: 40 });
  // Deliver a chunk every 20ms — well inside the 40ms window — for 100ms.
  for (let i = 0; i < 5; i += 1) {
    body.push(`frame-${i}`);
    await sleep(20);
    assert.equal(res.ended, false, `still alive while frames keep arriving (tick ${i})`);
  }
  // Now the client stops draining: the deadline firing while the pipe is
  // paused must re-arm instead of tearing down.
  res.writableNeedDrain = true;
  body.push('frame-buffered');
  await sleep(90);
  assert.equal(res.ended, false, 'a paused pipe earns another deadline, not a teardown');
  assert.equal(body.cancelled, false, 'the upstream stays connected behind a slow client');
  await done;
});

test('a body that ends normally clears the deadline without a forced teardown', async () => {
  const body = liveBody();
  body.push('frame-1');
  body.close();
  const res = fakeRes();
  await proxyMediaResponse(res, { status: 200, headers: new Headers(JPEG_PASSTHROUGH_HEADERS), body: body.stream }, { idleTimeoutMs: 25 });
  await sleep(60);
  assert.equal(res.ended, true, 'the relay finished the response');
  assert.equal(res.statusCode, 200);
  assert.equal(body.cancelled, false, 'a normal end releases nothing — the stream finished on its own');
});

test('watchDownstreamClose: an early goodbye aborts the signal; a normal end does not', () => {
  const resA = fakeRes();
  const downstream = watchDownstreamClose(resA);
  assert.equal(downstream.closed, false);
  resA.emit('close');
  assert.equal(downstream.closed, true, 'an unfinished response closing is an abandonment');
  assert.equal(downstream.signal.aborted, true);

  const resB = fakeRes();
  const normal = watchDownstreamClose(resB);
  resB.end();
  resB.emit('close');
  assert.equal(normal.closed, false, 'a response that ended normally also emits close');
  assert.equal(normal.signal.aborted, false);
});

test('the idle deadline default is twice the header deadline', () => {
  // Twice 15s: a camera slow between frames is common; a dead one is not.
  assert.equal(CCTV_MEDIA_IDLE_TIMEOUT_MS, 30 * 1000);
});
