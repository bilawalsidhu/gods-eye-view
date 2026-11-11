import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

/**
 * Opt-in gzip for text bodies a proxy already holds in memory.
 *
 * Not a middleware: `cctv/media.js` streams bodies and answers range requests,
 * and several providers forward binary upstream types that gzip only grows.
 * `encodedBody` returns the body with its headers so the two cannot disagree.
 */

/** Skip compression for bodies smaller than 1 KiB. */
const MIN_COMPRESSED_BYTES = 1024;

/**
 * RFC 9110 section 12.4.2 `qvalue`. Matching the whole token keeps `q=1oops`
 * and `q=2` unreadable instead of rounding them into acceptance.
 */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Whether `Accept-Encoding` offers gzip. Anything unreadable (no header, a bad
 * q value, `x-gzip`) reads as no: every client can decode identity.
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
    const quality = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith('q='));
    if (quality === undefined) return true;
    // `q=0` names gzip and refuses it.
    const value = quality.slice(2);
    return QVALUE.test(value) && Number(value) > 0;
  });
}

/**
 * Gzip a body once for a caller that caches it. Async, so the ~860 KB OpenSky
 * snapshot does not block other requests while it compresses.
 *
 * Returns null, meaning "serve identity", when the body is under 1 KiB or gzip
 * does not shrink it.
 *
 * @param {string|Buffer} body - the exact bytes the identity response sends.
 * @returns {Promise<Buffer|null>}
 */
export async function gzipBody(body) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (raw.byteLength < MIN_COMPRESSED_BYTES) return null;
  const compressed = await gzipAsync(raw);
  return compressed.byteLength < raw.byteLength ? compressed : null;
}

/**
 * Pick the body and the headers that describe it. `Vary` is on both branches
 * so a shared cache never serves one encoding to a client that asked for the
 * other.
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
