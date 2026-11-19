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

test('CCTV upstream frame fetch accepts only raster image types and sends their canonical type', async () => {
  const frame = (contentType, body = 'frame') => {
    const state = { cancelled: false };
    const headers = contentType === null ? {} : { 'Content-Type': contentType };
    const response = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    }, { highWaterMark: 0 }), { status: 200, headers });
    return { response, state };
  };
  for (const [contentType, canonical] of [
    ['image/jpeg', 'image/jpeg'],
    ['image/JPEG; charset=x', 'image/jpeg'],
    [' Image/PNG ', 'image/png'],
    ['image/gif', 'image/gif'],
    ['image/webp;q=1', 'image/webp'],
    ['image/avif', 'image/avif'],
  ]) {
    const { response } = frame(contentType);
    const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
      fetchImpl: async () => response,
    });
    assert.equal(result?.contentType, canonical, contentType);
    assert.equal(result.body.toString(), 'frame');
  }
  for (const [contentType, body] of [
    ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['Image/SVG+XML; charset=utf-8', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['text/html', '<!doctype html><p>x</p>'],
    ['text/html; charset=utf-8', '<!doctype html><p>x</p>'],
    ['application/xml', '<x/>'],
    ['text/xml', '<x/>'],
    [null, 'frame'],
    ['', 'frame'],
    ['image', 'frame'],
    ['image/', 'frame'],
    ['image/jpeg/x', 'frame'],
    ['image/jpeg, text/html', 'frame'],
    ['application/octet-stream', 'frame'],
  ]) {
    const { response, state } = frame(contentType, body);
    const result = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
      fetchImpl: async () => response,
    });
    assert.equal(result, null, String(contentType));
    assert.equal(state.cancelled, true, `${contentType}: body cancelled`);
  }
});

function multipartResponse(contentType, chunks, { onCancel = () => {} } = {}) {
  let nextChunk = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        if (nextChunk >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[nextChunk++]);
      },
      cancel() {
        onCancel();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
}

function jpegPart(boundary, body, contentType = 'image/jpeg', length = body.length) {
  return Buffer.concat([
    Buffer.from(
      '--' +
        boundary +
        '\r\nContent-Type: ' +
        contentType +
        '\r\nContent-Length: ' +
        length +
        '\r\n\r\n',
    ),
    body,
    Buffer.from('\r\n'),
  ]);
}

test('CCTV upstream frame fetch extracts only the first JPEG from MJPEG', async () => {
  const boundary = 'DIGIEVER';
  const first = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
  const second = Buffer.from([0xff, 0xd8, 0x33, 0x44, 0xff, 0xd9]);
  for (const type of [
    'multipart/x-mixed-replace; boundary=DIGIEVER',
    'multipart/x-mixed-replace; boundary="DIGIEVER"',
  ]) {
    let cancelled = false;
    const result = await fetchCctvImageFromUpstream(
      'https://cctv-ss02.thb.gov.tw/T62-9K+020',
      {
        allowMjpeg: true,
        maxBytes: 1024,
        fetchImpl: async () =>
          multipartResponse(
            type,
            [
              jpegPart(boundary, first),
              jpegPart(boundary, second),
              Buffer.from('--' + boundary + '--\r\n'),
            ],
            { onCancel: () => { cancelled = true; } },
          ),
      },
    );
    assert.equal(result?.contentType, 'image/jpeg', type);
    assert.deepEqual(result?.body, first, type);
    assert.equal(cancelled, true, type);
  }
});

test('CCTV upstream frame fetch rejects malformed and non-JPEG MJPEG parts', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  for (const [type, chunks] of [
    ['multipart/x-mixed-replace', []],
    [
      'multipart/x-mixed-replace; boundary=DIGIEVER',
      [jpegPart('DIGIEVER', jpeg, 'image/png')],
    ],
  ]) {
    let cancelled = false;
    const result = await fetchCctvImageFromUpstream(
      'https://cctv-ss02.thb.gov.tw/T62-9K+020',
      {
        allowMjpeg: true,
        fetchImpl: async () =>
          multipartResponse(type, chunks, { onCancel: () => { cancelled = true; } }),
      },
    );
    assert.equal(result, null, type);
    assert.equal(cancelled, true, type);
  }
});

test('CCTV upstream frame fetch rejects truncated or oversized MJPEG parts', async () => {
  const boundary = 'DIGIEVER';
  const full = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const truncated = Buffer.from([0xff, 0xd8, 0x01, 0x02]);
  for (const [chunks, maxBytes] of [
    [jpegPart(boundary, truncated, 'image/jpeg', full.length), 1024],
    [jpegPart(boundary, full), 5],
  ]) {
    let cancelled = false;
    const result = await fetchCctvImageFromUpstream(
      'https://cctv-ss02.thb.gov.tw/T62-9K+020',
      {
        allowMjpeg: true,
        maxBytes,
        fetchImpl: async () =>
          multipartResponse(
            'multipart/x-mixed-replace; boundary=' + boundary,
            [chunks],
            { onCancel: () => { cancelled = true; } },
          ),
      },
    );
    assert.equal(result, null);
    assert.equal(cancelled, true);
  }
});

test('CCTV upstream frame fetch does not cross into a later part when the first JPEG is truncated', async () => {
  const boundary = 'DIGIEVER';
  const truncated = Buffer.from([0xff, 0xd8, 0x01, 0x02]);
  const valid = Buffer.from([0xff, 0xd8, 0x03, 0x04, 0xff, 0xd9]);
  const wire = Buffer.concat([
    Buffer.from(
      '--' + boundary + '\r\nContent-Type: image/jpeg\r\n\r\n',
    ),
    truncated,
    Buffer.from(
      '\r\n--' +
        boundary +
        '\r\nContent-Type: image/jpeg\r\nContent-Length: ' +
        valid.length +
        '\r\n\r\n',
    ),
    valid,
    Buffer.from('\r\n--' + boundary + '--\r\n'),
  ]);
  let cancelled = false;

  const result = await fetchCctvImageFromUpstream(
    'https://cctv-ss02.thb.gov.tw/T62-9K+020',
    {
      allowMjpeg: true,
      maxBytes: 1024,
      fetchImpl: async () =>
        multipartResponse(
          'multipart/x-mixed-replace; boundary=' + boundary,
          [wire],
          { onCancel: () => { cancelled = true; } },
        ),
    },
  );

  assert.equal(result, null);
  assert.equal(cancelled, true);
});
test('CCTV upstream frame fetch ignores MJPEG unless the source is registered as MJPEG', async () => {
  const boundary = 'DIGIEVER';
  const jpeg = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
  let cancelled = false;
  const result = await fetchCctvImageFromUpstream(
    'https://cctv-ss02.thb.gov.tw/T62-9K+020',
    {
      fetchImpl: async () =>
        multipartResponse(
          'multipart/x-mixed-replace; boundary=' + boundary,
          [jpegPart(boundary, jpeg)],
          { onCancel: () => { cancelled = true; } },
        ),
    },
  );
  assert.equal(result, null);
  assert.equal(cancelled, true);
});

test('CCTV upstream frame fetch accepts a CRLF preamble and a boundary that already starts with --', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
  for (const [type, wire] of [
    [
      'multipart/x-mixed-replace; boundary=DIGIEVER',
      Buffer.concat([Buffer.from('\r\n'), jpegPart('DIGIEVER', jpeg)]),
    ],
    [
      'multipart/x-mixed-replace; boundary=--myboundary',
      Buffer.concat([
        Buffer.from(
          '--myboundary\r\nContent-Type: image/jpeg\r\nContent-Length: ' +
            jpeg.length +
            '\r\n\r\n',
        ),
        jpeg,
        Buffer.from('\r\n--myboundary\r\n'),
      ]),
    ],
  ]) {
    const result = await fetchCctvImageFromUpstream(
      'https://cctv-ss02.thb.gov.tw/T62-9K+020',
      {
        allowMjpeg: true,
        fetchImpl: async () => multipartResponse(type, [wire]),
      },
    );
    assert.deepEqual(result?.body, jpeg, type);
  }
});

test('CCTV MJPEG part without Content-Length ends at the next delimiter, not at an inner JPEG end marker', async () => {
  const boundary = 'DIGIEVER';
  // An EXIF thumbnail's own FF D9 sits inside the image.
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9, 0x02, 0x03, 0xff, 0xd9]);
  const wire = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: image/jpeg\r\n\r\n'),
    jpeg,
    Buffer.from('\r\n--' + boundary + '\r\nContent-Type: image/jpeg\r\n\r\n'),
  ]);
  // Delivered one byte at a time, as a trickling upstream would.
  const chunks = [...wire].map((byte) => Buffer.from([byte]));
  const result = await fetchCctvImageFromUpstream(
    'https://cctv-ss02.thb.gov.tw/T62-9K+020',
    {
      allowMjpeg: true,
      fetchImpl: async () =>
        multipartResponse('multipart/x-mixed-replace; boundary=' + boundary, chunks),
    },
  );
  assert.deepEqual(result?.body, jpeg);
});
