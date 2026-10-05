import { CCTV_FRAME_FETCH_TIMEOUT_MS, CCTV_FRAME_MAX_BODY_BYTES, CCTV_MEDIA_FETCH_TIMEOUT_MS, CCTV_MEDIA_MAX_BODY_BYTES } from '../../server/providers/cctv/constants.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCctvImageFromUpstream,
  fetchCctvMediaUpstream,
} from '../../server/providers/cctv/media.js';

/** A body that arrives in chunks and never declares a Content-Length. */
function chunkedImageResponse(chunkBytes, chunkCount, { onChunk = () => {}, onCancel = () => {} } = {}) {
  const stream = new ReadableStream({
    async pull(controller) {
      if (chunkCount <= 0) {
        controller.close();
        return;
      }
      chunkCount -= 1;
      onChunk();
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel: onCancel,
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
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
  assert.deepEqual(result?.body, Buffer.from([1, 2, 3]));
});

test('CCTV upstream frame fetch rejects a declared oversize body without draining it', async () => {
  const chunkBytes = 64 * 1024;
  let pulled = 0;
  let cancelled = false;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: chunkBytes * 4,
    fetchImpl: async () => {
      const response = chunkedImageResponse(chunkBytes, 64, {
        onChunk: () => { pulled += 1; },
        onCancel: () => { cancelled = true; },
      });
      response.headers.set('Content-Length', String(chunkBytes * 64));
      return response;
    },
  });

  // Assert on the byte count, not the object: a regressed proxy returns a
  // multi-megabyte Buffer here, and diffing one into the failure report is
  // slower than the check it is reporting on.
  assert.equal(result?.body?.length ?? null, null, 'a declared oversize snapshot is a miss, not a buffered body');
  assert.equal(cancelled, true, 'the declared cap is enforced by cancelling, not reading');
  // Only the stream's own one-chunk prefetch may have run; the proxy pulls none.
  assert.ok(pulled <= 1, `declared cap short-circuits the read, pulled ${pulled} chunks`);
});

test('CCTV upstream frame fetch aborts an undeclared body once it crosses the cap', async () => {
  const chunkBytes = 64 * 1024;
  let pulled = 0;
  let cancelled = false;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: chunkBytes * 4,
    // Sixty-four chunks are offered with no Content-Length; a proxy that
    // buffers first would take all of them.
    fetchImpl: async () => chunkedImageResponse(chunkBytes, 64, {
      onChunk: () => { pulled += 1; },
      onCancel: () => { cancelled = true; },
    }),
  });

  assert.equal(result?.body?.length ?? null, null, 'a chunked body over the cap is a miss');
  // Four chunks fit, the fifth crosses the cap, and one more sits in the
  // stream's prefetch queue — nothing past that is ever pulled.
  assert.ok(pulled <= 6, `stopped reading at the cap, pulled ${pulled} chunks`);
  assert.equal(cancelled, true, 'the upstream stream is cancelled, not drained');
});

test('CCTV upstream frame fetch still returns a chunked body under the cap', async () => {
  const chunkBytes = 1024;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: chunkBytes * 8,
    fetchImpl: async () => chunkedImageResponse(chunkBytes, 3),
  });

  assert.equal(result?.ok, true);
  assert.equal(result?.body?.length, chunkBytes * 3, 'every chunk is reassembled in order');
  assert.ok(CCTV_FRAME_MAX_BODY_BYTES > 0 && CCTV_FRAME_MAX_BODY_BYTES <= CCTV_MEDIA_MAX_BODY_BYTES,
    'the frame cap must be at or under the media route cap — pinned against the real constant');
});

test('CCTV media upstream fetch aborts when response headers never arrive', async () => {
  let observedSignal = null;
  const startedAt = Date.now();
  await assert.rejects(
    fetchCctvMediaUpstream('https://example.com/stream.m3u8', {
      timeoutMs: 25,
      fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
        observedSignal = signal;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(observedSignal?.aborted, true, 'the header deadline aborts the attempt');
  assert.ok(Date.now() - startedAt < 2_000, 'the deadline is the injected one, not the production one');
  assert.ok(CCTV_MEDIA_FETCH_TIMEOUT_MS >= 10_000, 'production keeps a generous header deadline for slow cameras');
});

test('CCTV media upstream fetch never cuts a stream whose headers arrived in time', async () => {
  let observedSignal = null;
  const upstream = await fetchCctvMediaUpstream('https://example.com/stream.m3u8', {
    timeoutMs: 20,
    fetchImpl: async (url, { signal }) => {
      observedSignal = signal;
      return { ok: true, status: 200, headers: new Map([['content-type', 'video/mp2t']]), body: null };
    },
  });
  assert.equal(upstream.ok, true);
  // Well past the header deadline: the timer was cleared at header arrival,
  // so the live body is still allowed to flow.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(observedSignal?.aborted, false, 'a slow body after timely headers is never aborted here');
});

test('CCTV upstream frame fetch keeps a body that lands exactly on the cap', async () => {
  const chunkBytes = 512;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: chunkBytes * 4,
    fetchImpl: async () => chunkedImageResponse(chunkBytes, 4),
  });
  assert.equal(result?.ok, true, 'exactly-at-cap is under the ceiling, not over it');
  assert.equal(result?.body?.length, chunkBytes * 4);
});

test('CCTV upstream frame fetch ignores a garbage Content-Length and still caps the stream', async () => {
  const chunkBytes = 1024;
  let cancelled = false;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: chunkBytes * 2,
    fetchImpl: async () => {
      const response = chunkedImageResponse(chunkBytes, 8, { onCancel: () => { cancelled = true; } });
      response.headers.set('Content-Length', 'not-a-number');
      return response;
    },
  });
  assert.equal(result?.body?.length ?? null, null, 'an unparseable length falls back to counting bytes');
  assert.equal(cancelled, true);
});

test('CCTV upstream frame fetch retains owned bytes, not the chunk\'s backing allocation', async () => {
  const backing = new ArrayBuffer(4 * 1024 * 1024);
  const view = new Uint8Array(backing, 8, 3);
  view.set([7, 8, 9]);
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: 1024,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(view);
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }),
  });
  assert.equal(result?.ok, true);
  assert.deepEqual(Array.from(result.body), [7, 8, 9]);
  assert.ok(result.body.buffer.byteLength < backing.byteLength,
    'the 4 MB backing allocation is not retained behind a 3-byte frame');
});

test('CCTV upstream frame fetch refuses a body it cannot stream instead of buffering it uncapped', async () => {
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 1000,
    maxBytes: 1024,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/jpeg']]),
      body: { /* neither async-iterable nor reader-backed */ },
      arrayBuffer: async () => { throw new Error('arrayBuffer must never be used as an uncapped fallback'); },
    }),
  });
  assert.equal(result, null);
});

test('reader-only snapshots release their lock on success, overflow and read failure', async () => {
  for (const mode of ['success', 'overflow', 'failure']) {
    const body = new ReadableStream({
      pull(controller) {
        if (mode === 'failure') controller.error(new Error('read failed'));
        else { controller.enqueue(new Uint8Array(4)); controller.close(); }
      },
    });
    Object.defineProperty(body, Symbol.asyncIterator, { value: undefined });
    const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
      maxBytes: mode === 'overflow' ? 2 : 8,
      fetchImpl: async () => ({ ok: true, headers: new Headers({ 'content-type': 'image/jpeg' }), body }),
    });
    assert.equal(body.locked, false, mode);
    assert.equal(result?.body.length ?? null, mode === 'success' ? 4 : null);
  }
});

test('the snapshot deadline remains active after headers while reading a stalled body', async () => {
  let signal;
  const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    timeoutMs: 20,
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      }}), { headers: { 'content-type': 'image/jpeg' } });
    },
  });
  assert.equal(result, null);
  assert.equal(signal.aborted, true);
});

test('rejected snapshot responses abort the upstream download', async () => {
  for (const [status, contentType] of [[503, 'image/jpeg'], [200, 'text/html']]) {
    let signal;
    const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
      fetchImpl: async (_url, init) => {
        signal = init.signal;
        return new Response('rejected', { status, headers: { 'content-type': contentType } });
      },
    });
    assert.equal(result, null);
    assert.equal(signal.aborted, true);
  }
});
