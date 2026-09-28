import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import {
  acceptsGzip,
  encodedBody,
  gzipBody,
} from '../../server/providers/common/compress.js';

/** A request shaped like the one Node hands a middleware. */
function request(acceptEncoding) {
  return {
    url: '/api/opensky',
    method: 'GET',
    headers:
      acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding },
  };
}

/** Repetitive JSON, the shape of an actual snapshot body. */
function snapshotBody(states = 200) {
  return JSON.stringify({
    time: 1700000000,
    states: Array.from({ length: states }, (_, index) => [
      `abc${index}`,
      'CALLSIGN',
      'United States',
      1700000000,
      30.1,
      -97.7,
      10000,
    ]),
  });
}

/**
 * Deterministic high-entropy bytes. Random data would do, but a seeded sequence
 * keeps the "gzip made it bigger" assertion from depending on luck.
 */
function incompressibleBytes(length) {
  const bytes = Buffer.alloc(length);
  let state = 123456789;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    bytes[index] = (state >>> 16) & 0xff;
  }
  return bytes;
}

test('accept-encoding is read the way clients actually write it', () => {
  assert.equal(acceptsGzip(request('gzip')), true);
  assert.equal(acceptsGzip(request('gzip, deflate, br')), true);
  assert.equal(acceptsGzip(request('br;q=1.0, gzip;q=0.8')), true);
  assert.equal(acceptsGzip(request('GZIP')), true);
  assert.equal(acceptsGzip(request(' gzip ')), true);

  assert.equal(acceptsGzip(request('br, deflate')), false);
  assert.equal(acceptsGzip(request('identity')), false);
  assert.equal(acceptsGzip(request('')), false);
  assert.equal(acceptsGzip(request(undefined)), false);
  assert.equal(acceptsGzip({}), false);
  assert.equal(acceptsGzip(undefined), false);

  // A quality of zero names gzip and refuses it (RFC 9110 section 12.4.2),
  // and an unreadable quality falls back to the encoding every client accepts.
  assert.equal(acceptsGzip(request('gzip;q=0')), false);
  assert.equal(acceptsGzip(request('gzip;q=0.000')), false);
  assert.equal(acceptsGzip(request('gzip;q=bogus')), false);
  assert.equal(acceptsGzip(request('gzip;q=0.001')), true);

  // `gzip` is not matched as a substring of a neighbouring token.
  assert.equal(acceptsGzip(request('x-gzip')), false);
  assert.equal(acceptsGzip(request('gzipped')), false);
});

test('a body is only compressed when compression pays for itself', async () => {
  assert.equal(await gzipBody(null), null);
  assert.equal(await gzipBody(undefined), null);
  assert.equal(await gzipBody(''), null);
  assert.equal(
    await gzipBody('{"states":[]}'),
    null,
    'below the frame threshold',
  );
  assert.equal(await gzipBody(Buffer.alloc(1023, 'a')), null, 'one byte short');

  const identity = snapshotBody();
  assert.ok(identity.length > 1024, 'fixture is worth compressing');
  const compressed = await gzipBody(identity);
  assert.ok(Buffer.isBuffer(compressed));
  assert.ok(compressed.byteLength < Buffer.byteLength(identity));
  assert.equal(gunzipSync(compressed).toString(), identity);

  // Buffers are accepted as-is, and data that gzip cannot shrink is refused
  // rather than served as a larger response.
  assert.ok((await gzipBody(Buffer.from(identity))) !== null);
  assert.equal(await gzipBody(incompressibleBytes(4096)), null);
});

test('the encoded body and the header that names it are chosen together', async () => {
  const identity = snapshotBody();
  const compressed = await gzipBody(identity);

  const negotiated = encodedBody(request('gzip'), identity, compressed);
  assert.equal(negotiated.body, compressed);
  assert.equal(negotiated.headers['Content-Encoding'], 'gzip');
  assert.equal(negotiated.headers.Vary, 'Accept-Encoding');
  assert.equal(gunzipSync(negotiated.body).toString(), identity);

  // Offered but not wanted: identity bytes, and no Content-Encoding to
  // contradict them.
  const refused = encodedBody(request('br'), identity, compressed);
  assert.equal(refused.body, identity);
  assert.equal(refused.headers['Content-Encoding'], undefined);
  assert.equal(refused.headers.Vary, 'Accept-Encoding');

  // Wanted but not available: same answer.
  const unavailable = encodedBody(request('gzip'), identity, null);
  assert.equal(unavailable.body, identity);
  assert.equal(unavailable.headers['Content-Encoding'], undefined);

  // Vary is on both branches: without it a shared cache could hand a stored
  // response to a client whose Accept-Encoding it was not selected for.
  assert.equal(unavailable.headers.Vary, 'Accept-Encoding');
  assert.equal(
    encodedBody(request(undefined), identity, compressed).headers.Vary,
    'Accept-Encoding',
  );
});
