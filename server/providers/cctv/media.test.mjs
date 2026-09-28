import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffImageContentType, fetchCctvImageFromUpstream } from './media.js';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
]);
const HTML_BODY = Buffer.from('<html><body>not an image</body></html>');

/** Build a fetch()-shaped Response stand-in for fetchWithinHost/readCappedResponseBytes. */
function fakeUpstream({
  status = 200,
  ok = true,
  contentType = null,
  contentLength = null,
  bodyChunks = [],
} = {}) {
  return {
    status,
    ok,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return contentLength;
        return null;
      },
    },
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of bodyChunks) yield chunk;
      },
      async cancel() {},
    },
    async arrayBuffer() {
      return Buffer.concat(bodyChunks.map((chunk) => Buffer.from(chunk)));
    },
  };
}

function fetchImplFor(upstream) {
  return async () => upstream;
}

// --- sniffImageContentType: pure magic-byte identification ---------------

test('sniffImageContentType identifies JPEG/PNG signatures and rejects short/unknown bytes', () => {
  assert.equal(sniffImageContentType(JPEG_MAGIC), 'image/jpeg');
  assert.equal(sniffImageContentType(PNG_MAGIC), 'image/png');
  assert.equal(sniffImageContentType(Buffer.from([0x00, 0x01])), null); // too short
  assert.equal(
    sniffImageContentType(Buffer.from([0x00, 0x00, 0x00, 0x00])),
    null,
  ); // malformed/unknown magic
  assert.equal(sniffImageContentType(HTML_BODY), null);
  assert.equal(sniffImageContentType(null), null);
});

// --- fetchCctvImageFromUpstream: the shared sniff-fallback path ----------

test('missing/wrong Content-Type + valid JPEG body is accepted as image/jpeg', async () => {
  const missingHeader = fakeUpstream({
    contentType: null,
    bodyChunks: [JPEG_MAGIC],
  });
  const result = await fetchCctvImageFromUpstream(
    'https://example.com/frame.jpg',
    {
      fetchImpl: fetchImplFor(missingHeader),
    },
  );
  assert.ok(result);
  assert.equal(result.contentType, 'image/jpeg');
  assert.deepEqual(result.body, JPEG_MAGIC);

  const wrongHeader = fakeUpstream({
    contentType: 'text/plain',
    bodyChunks: [JPEG_MAGIC],
  });
  const result2 = await fetchCctvImageFromUpstream(
    'https://example.com/frame.jpg',
    {
      fetchImpl: fetchImplFor(wrongHeader),
    },
  );
  assert.equal(result2.contentType, 'image/jpeg');
});

test('wrong Content-Type + ordinary HTML body is rejected', async () => {
  const upstream = fakeUpstream({
    contentType: 'text/html',
    bodyChunks: [HTML_BODY],
  });
  const result = await fetchCctvImageFromUpstream(
    'https://example.com/frame.jpg',
    {
      fetchImpl: fetchImplFor(upstream),
    },
  );
  assert.equal(result, null);
});

test('short or malformed magic bytes are rejected even with no declared Content-Type', async () => {
  const shortBody = fakeUpstream({
    contentType: null,
    bodyChunks: [Buffer.from([0x01, 0x02])],
  });
  assert.equal(
    await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
      fetchImpl: fetchImplFor(shortBody),
    }),
    null,
  );

  const malformedBody = fakeUpstream({
    contentType: null,
    bodyChunks: [Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00])],
  });
  assert.equal(
    await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
      fetchImpl: fetchImplFor(malformedBody),
    }),
    null,
  );
});

test('a declared image/* Content-Type is trusted as-is, unchanged from prior behavior', async () => {
  // The declared header is trusted outright, even over bytes that would fail
  // the sniff on their own — this is the pre-existing fast path and must not
  // regress when the sniff fallback is added alongside it.
  const upstream = fakeUpstream({
    contentType: 'image/png',
    bodyChunks: [Buffer.from('not actually PNG bytes')],
  });
  const result = await fetchCctvImageFromUpstream(
    'https://example.com/frame.png',
    {
      fetchImpl: fetchImplFor(upstream),
    },
  );
  assert.ok(result);
  assert.equal(result.contentType, 'image/png');
});

test('the body size cap still applies before a frame can succeed', async () => {
  // Declared Content-Length above the cap short-circuits without reading the body.
  const declaredTooLarge = fakeUpstream({
    contentType: null,
    contentLength: '1000',
    bodyChunks: [JPEG_MAGIC],
  });
  assert.equal(
    await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
      fetchImpl: fetchImplFor(declaredTooLarge),
      maxBytes: 100,
    }),
    null,
  );

  // An undeclared body that streams past the cap is also rejected, even
  // though it starts with a valid JPEG signature.
  const streamedTooLarge = fakeUpstream({
    contentType: null,
    bodyChunks: [JPEG_MAGIC, Buffer.alloc(50, 0xaa)],
  });
  assert.equal(
    await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
      fetchImpl: fetchImplFor(streamedTooLarge),
      maxBytes: 8,
    }),
    null,
  );

  // Staying within the cap still succeeds.
  const withinCap = fakeUpstream({
    contentType: null,
    bodyChunks: [JPEG_MAGIC],
  });
  const ok = await fetchCctvImageFromUpstream('https://example.com/frame.jpg', {
    fetchImpl: fetchImplFor(withinCap),
    maxBytes: JPEG_MAGIC.length,
  });
  assert.ok(ok);
});
