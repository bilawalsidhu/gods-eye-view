import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  CCTV_IMAGE_MAX_BYTES,
  CCTV_STREAM_HEADER_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
  fetchMediaHeadersBounded,
  normalizeSourceItem,
  readBytesCapped,
} from './cctvSources.js';

/** A Response whose body is a real ReadableStream (so readBytesCapped takes
 * the streaming path, not the arrayBuffer fallback). */
function streamResponse(chunks, { headers = {}, onCancel } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
    ...(onCancel ? { cancel: onCancel } : {}),
  });
  return new Response(stream, { headers });
}

test('CCTV upstream frame fetch supplies a bounded abort signal', async () => {
  let observedSignal = null;
  const startedAt = Date.now();
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      observedSignal = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });

  assert.equal(result, null);
  assert.ok(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - startedAt < 500, 'test timeout should settle promptly');
  assert.ok(CCTV_FRAME_FETCH_TIMEOUT_MS < 10_000, 'production timeout must beat the active refresh cadence');
});

test('CCTV upstream frame fetch returns a valid image response', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 100,
    fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg' },
    }),
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.contentType, 'image/jpeg');
  // Uint8Array (not Buffer) so the shared module stays worker-safe; Node's
  // res.end() and the Workers Response constructor both take it verbatim.
  assert.deepEqual(result?.body, new Uint8Array([1, 2, 3]));
  assert.equal(result?.body.byteLength, 3);
});

test('readBytesCapped: bodies under the cap pass through byte-exact', async () => {
  const read = await readBytesCapped(streamResponse([[1, 2, 3], [4, 5], [6]]), 1024);
  assert.equal(read.ok, true);
  assert.deepEqual(read.bytes, new Uint8Array([1, 2, 3, 4, 5, 6]));
});

test('readBytesCapped: an undeclared oversized body is cut off mid-stream', async () => {
  let cancelled = false;
  const big = Array.from({length: 100}).fill(Array.from({length: 64}).fill(7)); // 6400 bytes
  const response = streamResponse(big, { onCancel: () => { cancelled = true; } });
  const read = await readBytesCapped(response, 1024);
  assert.equal(read.ok, false);
  assert.equal(cancelled, true, 'the upstream body must be cancelled, not fully buffered');
});

test('readBytesCapped: a declared oversized content-length short-circuits', async () => {
  let readAtAll = false;
  const response = {
    headers: new Headers({ 'content-length': String(CCTV_IMAGE_MAX_BYTES + 1) }),
    body: {
      getReader: () => ({ read: async () => { readAtAll = true; return { done: true, value: undefined }; } }),
      cancel: async () => {},
    },
  };
  const read = await readBytesCapped(response, CCTV_IMAGE_MAX_BYTES);
  assert.equal(read.ok, false);
  assert.equal(readAtAll, false, 'no byte of an over-cap declared body should be read');
});

test('readBytesCapped: responses without a stream body fall back to arrayBuffer', async () => {
  const response = {
    headers: new Headers(),
    body: null,
    arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
  };
  const read = await readBytesCapped(response, 1024);
  assert.equal(read.ok, true);
  assert.deepEqual(read.bytes, new Uint8Array([9, 8, 7]));

  const tooBig = {
    headers: new Headers(),
    body: null,
    arrayBuffer: async () => new Uint8Array(2048).buffer,
  };
  assert.equal((await readBytesCapped(tooBig, 1024)).ok, false);
});

test('fetchMediaHeadersBounded: a dark upstream aborts at the header deadline', async () => {
  const observed = { signal: null, headers: null };
  const startedAt = Date.now();
  const result = await fetchMediaHeadersBounded('https://example.com/live.m3u8', {
    headers: { Range: 'bytes=0-' },
    timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      observed.signal = options.signal;
      observed.headers = options.headers;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(observed.signal.aborted, true);
  assert.deepEqual(observed.headers, { Range: 'bytes=0-' }, 'validated Range must reach the upstream');
  assert.ok(Date.now() - startedAt < 500, 'header deadline should settle promptly');
  assert.ok(CCTV_STREAM_HEADER_TIMEOUT_MS > 0);
});

test('fetchMediaHeadersBounded: headers disarm the timer so streams survive', async () => {
  const controller = new AbortController();
  const result = await fetchMediaHeadersBounded('https://example.com/live.mjpeg', {
    timeoutMs: 30,
    fetchImpl: async () => new Response('x', { signal: controller.signal }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.upstream.ok, true);
  result.disarm();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(controller.signal.aborted, false, 'a disarmed timer must never kill a healthy unbounded stream');
});

test('fetchMediaHeadersBounded: without disarm the timer still fires (contract)', async () => {
  let upstreamSignal = null;
  const result = await fetchMediaHeadersBounded('https://example.com/live.mjpeg', {
    timeoutMs: 30,
    fetchImpl: async (_url, options) => {
      upstreamSignal = options.signal;
      return new Response('x', { signal: options.signal });
    },
  });
  assert.equal(result.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(upstreamSignal.aborted, true, 'callers MUST disarm once they take the body');
});

test('normalizeSourceItem: load-time URL validation (issue #29)', () => {
  const good = normalizeSourceItem({
    id: 'cam-1',
    name: 'Congress & 6th',
    url: 'https://cctv.austinmobility.io/image/loc1.jpg',
    snapshotUrl: 'http://cwwp2.dot.ca.gov/img1.jpg', // plaintext http is legitimate
  });
  assert.equal(good.url, 'https://cctv.austinmobility.io/image/loc1.jpg');
  assert.equal(good.snapshotUrl, 'http://cwwp2.dot.ca.gov/img1.jpg');

  for (const hostile of [
    'http://localhost/frame.jpg',
    'http://127.0.0.1/frame.jpg',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.1.10/frame.jpg',
    'https://user:pass@example.com/frame.jpg',
    'ftp://example.com/file',
    'javascript:alert(1)',
    '',
  ]) {
    const item = normalizeSourceItem({ id: 'x', url: hostile, snapshotUrl: hostile });
    assert.equal(item.url, '', `hostile url must sanitize to '': ${JSON.stringify(hostile)}`);
    assert.equal(item.snapshotUrl, '');
  }

  const nonString = normalizeSourceItem({ id: 'x', url: 42, snapshotUrl: null });
  assert.equal(nonString.url, '');
  assert.equal(nonString.snapshotUrl, '');
});

test('normalizeSourceItem: non-URL fields still normalize alongside the guard', () => {
  const item = normalizeSourceItem({
    id: ' cam-2 ',
    name: '',
    feedType: 'MJPG',
    lat: '30.2672',
    headingDeg: 91,
    poseSource: 'curated',
    url: 'https://example.com/f.jpg',
  });
  assert.equal(item.id, 'cam-2');
  assert.equal(item.name, 'cam-2', 'name falls back to id');
  assert.equal(item.feedType, 'mjpeg');
  assert.equal(item.lat, 30.2672);
  assert.equal(item.headingDeg, 91);
  assert.equal(item.poseSource, 'curated');
  assert.equal(item.url, 'https://example.com/f.jpg');
});

test('fetchCctvImageFromUpstream refuses unsafe URLs without fetching (last-line SSRF gate)', async () => {
  let called = false;
  const result = await fetchCctvImageFromUpstream('http://169.254.169.254/latest/meta-data', {
    fetchImpl: async () => { called = true; return new Response('secret'); },
  });
  assert.equal(result, null);
  assert.equal(called, false, 'the gate must reject before any network activity');
});

test('fetchCctvImageFromUpstream enforces the image byte cap via readBytesCapped', async () => {
  let cancelled = false;
  let sent = 0;
  const endlessLiar = new Response(new ReadableStream({
    pull(controller) {
      // A hostile upstream that never declares content-length and never ends:
      // hand out 1 MB chunks until the reader walks away.
      const chunk = new Uint8Array(1024 * 1024).fill(1);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel: () => { cancelled = true; },
  }), { headers: { 'Content-Type': 'image/jpeg' } });

  const result = await fetchCctvImageFromUpstream('https://example.com/big.jpg', {
    timeoutMs: 2000,
    fetchImpl: async () => endlessLiar,
  });
  assert.equal(result, null, 'a body past CCTV_IMAGE_MAX_BYTES must not resolve ok');
  assert.equal(cancelled, true, 'the runaway body must be cancelled, not drained');
  assert.ok(sent > CCTV_IMAGE_MAX_BYTES, `read ${sent} bytes before bailing`);
  assert.ok(CCTV_IMAGE_MAX_BYTES === 8 * 1024 * 1024);
});
