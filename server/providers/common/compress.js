import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

/**
 * Response compression for proxies that already hold a whole body in memory.
 *
 * Deliberately not a middleware. Two response paths in this tree must never be
 * wrapped: `cctv/media.js` streams a piped body and answers byte-range requests
 * with 206, and `wind/gfs.js` also serves ranges — a wrapper that buffered or
 * re-encoded those would break playback and range semantics. Seven providers
 * additionally forward an upstream `content-type` verbatim, including already
 * compressed binary formats that gzip would only make larger.
 *
 * So compression is opt-in at the call site, for bodies the proxy holds and
 * knows to be text. The failure mode of forgetting a site is a response that is
 * merely uncompressed, never a corrupt one — but only as long as the encoded
 * body and its `Content-Encoding` are chosen together, which is why
 * `encodedBody` returns both rather than exposing them separately.
 */

/** Below this, a gzip frame costs more than the bytes it saves. */
const MIN_COMPRESSED_BYTES = 1024;

/**
 * Whether the client offered gzip in `Accept-Encoding`.
 *
 * Anything this cannot read confidently — a missing header, a malformed
 * quality value, the `x-gzip` alias — reads as "no", because the fallback is an
 * identity response every client can decode.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
export function acceptsGzip(request) {
  const header = request?.headers?.['accept-encoding'];
  if (typeof header !== 'string') return false;
  return header.split(',').some((part) => {
    const [token, ...parameters] = part.split(';');
    if (token.trim().toLowerCase() !== 'gzip') return false;
    // `q=0` is the one way a client can name an encoding and still refuse it
    // (RFC 9110 section 12.4.2).
    const quality = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith('q='));
    return quality === undefined || Number.parseFloat(quality.slice(2)) > 0;
  });
}

/**
 * Gzip a body once, for callers that cache it and serve it many times.
 *
 * OpenSky's snapshot is ~860 KB and is held for the cache TTL, so this is paid
 * per refresh rather than per request. It runs off the event loop on purpose:
 * on that snapshot the synchronous call stalls every other in-flight request by
 * 11 ms, while this stalls them by under 1 ms and costs the caller — which is
 * already waiting on an upstream fetch — about 5 ms more of its own latency.
 *
 * Returns null when the body is too small to be worth a frame, so callers can
 * store the result directly and treat null as "serve identity".
 *
 * @param {string|Buffer} body - the exact bytes the identity response sends.
 * @returns {Promise<Buffer|null>}
 */
export async function gzipBody(body) {
  if (body == null) return null;
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  if (raw.byteLength < MIN_COMPRESSED_BYTES) return null;
  const compressed = await gzipAsync(raw);
  return compressed.byteLength < raw.byteLength ? compressed : null;
}

/**
 * Pick the body to send and the headers that describe it, together.
 *
 * `Vary: Accept-Encoding` is set on both branches, not only the compressed one:
 * a cache that stored an identity response without it would later hand those
 * bytes to a client that asked for gzip, and vice versa.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {string|Buffer} identity - the uncompressed body.
 * @param {Buffer|null} compressed - `gzipBody(identity)`, or null.
 * @returns {{body: string|Buffer, headers: Record<string,string>}}
 */
export function encodedBody(request, identity, compressed) {
  if (compressed && acceptsGzip(request)) {
    return {
      body: compressed,
      headers: { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' },
    };
  }
  return { body: identity, headers: { Vary: 'Accept-Encoding' } };
}
