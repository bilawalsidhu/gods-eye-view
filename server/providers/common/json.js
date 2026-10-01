import { readRequestBody } from './request.js';

/**
 * Small JSON route helpers shared by the history, alerts and coverage
 * providers. Error bodies are fixed strings; upstream or internal error
 * text is never echoed to the client.
 */

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

export function sendError(res, status, code) {
  sendJson(res, status, { error: code });
}

/** Parse a JSON request body (default cap 256 KB). Throws {code}. */
export async function readJson(req, maxBytes = 256 * 1024) {
  const text = await readRequestBody(req, maxBytes);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const error = new Error('invalid json');
    error.code = 'BAD_JSON';
    throw error;
  }
}

/**
 * The owner of user-authored data for this request. The hosted server sets
 * `req.gevUser` after authentication; the local profile is single-user.
 */
export function requestOwner(req) {
  const id = req?.gevUser?.id;
  return typeof id === 'string' && id ? id : 'local';
}

/** Path + URLSearchParams for a connect-style mounted request. */
export function parseUrl(req) {
  const url = new URL(req.url || '/', 'http://local');
  return { path: url.pathname.replace(/\/+$/, '') || '/', params: url.searchParams };
}

/** Parse "minLat,minLon,maxLat,maxLon" into a box, or null. */
export function parseBbox(text) {
  if (!text) return null;
  const v = String(text).split(',').map(Number);
  if (v.length !== 4 || !v.every(Number.isFinite)) return null;
  const [minLat, minLon, maxLat, maxLon] = v;
  if (minLat >= maxLat || minLon >= maxLon) return null;
  if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) return null;
  if (Math.abs(minLon) > 180 || Math.abs(maxLon) > 180) return null;
  return { minLat, minLon, maxLat, maxLon };
}

/** Parse a time param: epoch ms, ISO string, or relative "-6h"/"-30m"/"-2d". */
export function parseTime(text, now = Date.now()) {
  if (text === null || text === undefined || text === '') return null;
  const s = String(text).trim();
  const rel = /^-(\d+(?:\.\d+)?)([smhd])$/.exec(s);
  if (rel) {
    const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[rel[2]];
    return Math.round(now - Number(rel[1]) * unit);
  }
  if (/^\d{10,14}$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/** Wrap an async connect handler so thrown errors become fixed 4xx/5xx. */
export function route(name, handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error?.code === 'BODY_TOO_LARGE') return sendError(res, 413, 'body_too_large');
      if (error?.code === 'BAD_JSON') return sendError(res, 400, 'invalid_json');
      if (error?.code === 'BAD_REQUEST')
        return sendJson(res, 400, { error: 'bad_request', detail: error.message });
      console.error(`[${name}]`, error?.message || error);
      sendError(res, 500, 'internal_error');
    }
  };
}

/** Throw a 400 with a short, safe message. */
export function badRequest(message) {
  const error = new Error(String(message).slice(0, 200));
  error.code = 'BAD_REQUEST';
  throw error;
}
