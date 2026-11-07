import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffImageContentType, fetchCctvImageFromUpstream } from './media.js';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
]);
const HTML_BODY = Buffer.from('<html><body>not an image</body></html>');
const SVG_BODY = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
/** The one host the magic-byte fallback is enabled for. */
const VIGO_FRAME = 'https://camaras.vigo.org/camv2.php?id=1';
/** Any other registered host: must still declare a raster type. */
const OTHER_FRAME = 'https://example.com/frame.jpg';

/** Build a fetch()-shaped Response stand-in for fetchWithinHost/readCappedResponseBytes. */
const cancelled = { count: 0 };

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
      async cancel() {
        cancelled.count += 1;
      },
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

test('sniffImageContentType identifies JPEG/PNG/GIF/WebP signatures and rejects short/unknown bytes', () => {
  assert.equal(
    sniffImageContentType(Buffer.from('GIF87a\x01\x00', 'latin1')),
    'image/gif',
  );
  assert.equal(
    sniffImageContentType(Buffer.from('GIF89a\x01\x00', 'latin1')),
    'image/gif',
  );
  assert.equal(
    sniffImageContentType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')),
    'image/webp',
  );
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

test('Vigo: missing/wrong Content-Type + valid JPEG body is accepted as image/jpeg', async () => {
  const missingHeader = fakeUpstream({
    contentType: null,
    bodyChunks: [JPEG_MAGIC],
  });
  const result = await fetchCctvImageFromUpstream(VIGO_FRAME, {
    fetchImpl: fetchImplFor(missingHeader),
  });
  assert.ok(result);
  assert.equal(result.contentType, 'image/jpeg');
  assert.deepEqual(result.body, JPEG_MAGIC);

  const wrongHeader = fakeUpstream({
    contentType: 'text/plain',
    bodyChunks: [JPEG_MAGIC],
  });
  const result2 = await fetchCctvImageFromUpstream(VIGO_FRAME, {
    fetchImpl: fetchImplFor(wrongHeader),
  });
  assert.equal(result2.contentType, 'image/jpeg');
});

test('Vigo: wrong Content-Type + ordinary HTML body is rejected', async () => {
  const upstream = fakeUpstream({
    contentType: 'text/html',
    bodyChunks: [HTML_BODY],
  });
  const result = await fetchCctvImageFromUpstream(VIGO_FRAME, {
    fetchImpl: fetchImplFor(upstream),
  });
  assert.equal(result, null);
});

test('Vigo: short or malformed magic bytes are rejected even with no declared Content-Type', async () => {
  const shortBody = fakeUpstream({
    contentType: null,
    bodyChunks: [Buffer.from([0x01, 0x02])],
  });
  assert.equal(
    await fetchCctvImageFromUpstream(VIGO_FRAME, {
      fetchImpl: fetchImplFor(shortBody),
    }),
    null,
  );

  const malformedBody = fakeUpstream({
    contentType: null,
    bodyChunks: [Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00])],
  });
  assert.equal(
    await fetchCctvImageFromUpstream(VIGO_FRAME, {
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
    await fetchCctvImageFromUpstream(VIGO_FRAME, {
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
    await fetchCctvImageFromUpstream(VIGO_FRAME, {
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
  const ok = await fetchCctvImageFromUpstream(VIGO_FRAME, {
    fetchImpl: fetchImplFor(withinCap),
    maxBytes: JPEG_MAGIC.length,
  });
  assert.ok(ok);
});

test('sniffImageContentType rejects near-miss PNG and GIF signatures', () => {
  // First four PNG bytes, then a broken line-ending check: not a PNG.
  assert.equal(
    sniffImageContentType(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x0d, 0x1a, 0x0a, 0, 0]),
    ),
    null,
  );
  // "GIF8" without the 7a/9a version.
  assert.equal(
    sniffImageContentType(Buffer.from('GIF8xa\x01', 'latin1')),
    null,
  );
  assert.equal(sniffImageContentType(Buffer.from('GIF8', 'latin1')), null);
  assert.equal(sniffImageContentType(SVG_BODY), null);
});

test('hosts other than Vigo get no sniff fallback and the body is not read', async () => {
  const before = cancelled.count;
  const missingHeader = fakeUpstream({
    contentType: null,
    bodyChunks: [JPEG_MAGIC],
  });
  assert.equal(
    await fetchCctvImageFromUpstream(OTHER_FRAME, {
      fetchImpl: fetchImplFor(missingHeader),
    }),
    null,
  );
  const htmlHeader = fakeUpstream({
    contentType: 'text/html',
    bodyChunks: [JPEG_MAGIC],
  });
  assert.equal(
    await fetchCctvImageFromUpstream(OTHER_FRAME, {
      fetchImpl: fetchImplFor(htmlHeader),
    }),
    null,
  );
  assert.equal(cancelled.count, before + 2, 'each refused body is cancelled');
});

test('a declared SVG is never relayed, on Vigo or elsewhere', async () => {
  for (const url of [VIGO_FRAME, OTHER_FRAME]) {
    const upstream = fakeUpstream({
      contentType: 'image/svg+xml',
      bodyChunks: [SVG_BODY],
    });
    assert.equal(
      await fetchCctvImageFromUpstream(url, {
        fetchImpl: fetchImplFor(upstream),
      }),
      null,
      url,
    );
  }
});
