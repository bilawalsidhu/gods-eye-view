/**
 * Portable HTTP plumbing shared by every api/ondemand/*.js handler:
 * JSON body reading (with a byte cap), raw body reading (for multipart
 * forwarding), method guards, JSON response helpers, and a same-origin
 * (CSRF) guard.
 *
 * Written against plain Node `http.IncomingMessage` / `ServerResponse`
 * (`res.statusCode`, `res.setHeader`, `res.write`, `res.end`) — no
 * `res.json()`/`req.body`-only assumptions beyond what Vercel documents:
 * Vercel pre-parses JSON bodies into `req.body` for Node functions, and a
 * local emulator may do the same, so `readJsonBody` handles BOTH an
 * already-parsed `req.body` and a raw stream.
 */

const DEFAULT_JSON_MAX_BYTES = 1024 * 1024; // 1 MB default (task spec)

/** Thrown by readJsonBody/readRawBody; handlers catch this and respond with
 * `err.status` + `err.payload` instead of a generic 500. */
export class BodyError extends Error {
  constructor(status, payload) {
    super((payload && payload.error) || 'body_error');
    this.status = status;
    this.payload = payload;
  }
}

async function readStreamCapped(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new BodyError(413, { error: 'payload_too_large', maxBytes });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseJsonOrThrow(text) {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError(400, { error: 'invalid_json' });
  }
}

/**
 * Read and JSON-parse a request body.
 *   - `req.body` already an object (not a Buffer) -> returned as-is (Vercel
 *     / the local emulator already parsed it).
 *   - `req.body` a string or Buffer -> JSON.parse'd.
 *   - otherwise -> the stream is read via async iteration up to `maxBytes`,
 *     then JSON.parse'd.
 * Throws BodyError(400) on invalid JSON, BodyError(413) over the byte cap.
 * @param {import('http').IncomingMessage} req
 * @param {{ maxBytes?: number }} [opts]
 */
export async function readJsonBody(
  req,
  { maxBytes = DEFAULT_JSON_MAX_BYTES } = {},
) {
  const existing = req.body;
  if (existing !== undefined && existing !== null) {
    if (Buffer.isBuffer(existing)) {
      if (existing.length > maxBytes)
        throw new BodyError(413, { error: 'payload_too_large', maxBytes });
      return parseJsonOrThrow(existing.toString('utf8'));
    }
    if (typeof existing === 'string') {
      if (Buffer.byteLength(existing, 'utf8') > maxBytes) {
        throw new BodyError(413, { error: 'payload_too_large', maxBytes });
      }
      return parseJsonOrThrow(existing);
    }
    if (typeof existing === 'object') {
      return existing; // already parsed upstream of this handler
    }
  }
  const buf = await readStreamCapped(req, maxBytes);
  if (buf.length === 0) return {};
  return parseJsonOrThrow(buf.toString('utf8'));
}

/**
 * Read a request body as raw bytes, verbatim — used for forwarding
 * `multipart/form-data` uploads without re-encoding (contract §5.2).
 *   - `req.body` already a Buffer -> returned as-is.
 *   - `req.body` a string -> encoded back to a Buffer (best effort; a
 *     platform that decoded multipart bytes as a string may have already
 *     corrupted binary content, but we do not invent a recovery path).
 *   - `req.body` parsed into any other object -> BodyError(415): the raw
 *     bytes needed to forward the upload verbatim are gone.
 *   - otherwise -> the stream is read via async iteration up to `maxBytes`.
 * @param {import('http').IncomingMessage} req
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function readRawBody(req, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const existing = req.body;
  if (Buffer.isBuffer(existing)) {
    if (existing.length > maxBytes)
      throw new BodyError(413, { error: 'payload_too_large', maxBytes });
    return existing;
  }
  if (typeof existing === 'string') {
    const buf = Buffer.from(existing, 'utf8');
    if (buf.length > maxBytes)
      throw new BodyError(413, { error: 'payload_too_large', maxBytes });
    return buf;
  }
  if (
    existing !== undefined &&
    existing !== null &&
    typeof existing === 'object'
  ) {
    throw new BodyError(415, {
      error: 'unsupported_body_parsing',
      message:
        'multipart/form-data body was pre-parsed into a non-Buffer value by the platform; raw bytes are required to forward the upload verbatim to OnDemand.',
    });
  }
  return readStreamCapped(req, maxBytes);
}

/** Write a JSON response with the mandated headers (Content-Type + no-store). */
export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * 405 with an `Allow` header listing the supported methods.
 * @param {import('http').ServerResponse} res
 * @param {string[]} allowed
 */
export function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { error: 'method_not_allowed', allow: allowed });
}

/**
 * Guard a handler to only the given methods; sends 405 + Allow and returns
 * false when the method isn't supported so callers can `return` early:
 *   if (!assertMethod(req, res, ['GET', 'POST'])) return;
 */
export function assertMethod(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    methodNotAllowed(res, allowed);
    return false;
  }
  return true;
}

/** Build a `URL` from a Node request (`req.url` + `req.headers.host`). */
export function getRequestUrl(req) {
  const host = req.headers?.host || 'localhost';
  return new URL(req.url || '/', `http://${host}`);
}

/**
 * Cheap same-origin guard (CSRF mitigation), standing in for the FalKonEye
 * blueprint's ONDEMAND_PROXY_SHARED_SECRET (deferred — see
 * docs/ONDEMAND_PROXY_DESIGN.md "Dropped env vars"; this proxy is
 * same-origin and otherwise unauthenticated). When an Origin header is
 * present, its host must match the request's Host header. When Origin is
 * absent, Referer is used if present. When NEITHER header is present the
 * request is allowed through (nothing to compare against — many non-browser
 * clients, and the contract test script, never send either).
 * @param {import('http').IncomingMessage} req
 * @returns {boolean} true if the request passes the guard.
 */
export function isSameOrigin(req) {
  const host = req.headers?.host;
  if (!host) return true;
  const candidate = req.headers?.origin || req.headers?.referer;
  if (!candidate) return true;
  try {
    return new URL(candidate).host === host;
  } catch {
    return false; // malformed Origin/Referer -> fail closed
  }
}

/**
 * Reject a cross-origin request with 403. Returns true when it rejected (so
 * callers can `if (rejectCrossOrigin(req, res)) return;`), false when the
 * request may proceed.
 */
export function rejectCrossOrigin(req, res) {
  if (isSameOrigin(req)) return false;
  sendJson(res, 403, {
    error: 'cross_origin_rejected',
    message:
      'Origin/Referer host does not match Host; this proxy is same-origin only.',
  });
  return true;
}
