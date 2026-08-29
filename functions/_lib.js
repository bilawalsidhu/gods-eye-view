// functions/_lib.js
/**
 * Shared helpers for the God's Eye View Cloudflare Pages Functions.
 *
 * The dev server (`vite.config.js`) implements every `/api/*` route as Node
 * middleware. This directory is the production counterpart: Cloudflare Pages
 * serves `functions/` as Workers, so the browser contract (`/api/...`) keeps
 * working on the static deployment instead of 405ing.
 *
 * Worker-safe only: no Node APIs. Response helpers mirror the exact status
 * codes and JSON error shapes the dev middlewares emit, so client error
 * handling cannot tell the two runtimes apart.
 *
 * Rate limiting: the dev limiter is a per-process Map. Workers are
 * multi-isolate, so module state here is per-isolate — a backstop, not a
 * global quota. That is honest parity with the dev behavior (a backstop
 * against a runaway client), not a hard limit; a real global quota needs a
 * Durable Object and is deliberately out of scope until a limit is abused.
 *
 * @module functions/_lib
 */

/** JSON response with the same headers the dev middlewares set. */
export function jsonResponse(data, { status = 200, cacheControl = null } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (cacheControl) headers['Cache-Control'] = cacheControl;
  return new Response(JSON.stringify(data), { status, headers });
}

/** 405 with the dev middleware's exact error body. */
export function methodNotAllowed() {
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 });
}

/**
 * Read and parse a JSON request body, rejecting oversized payloads the same
 * way the dev `readRequestBody` helper does.
 *
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<{ok: true, value: object}|{ok: false, status: number, error: string}>}
 */
export async function readJsonBody(request, maxBytes) {
  const raw = await request.text();
  const size = new TextEncoder().encode(raw).length;
  if (size > maxBytes) {
    return { ok: false, status: 400, error: `Request body exceeds ${maxBytes} bytes` };
  }
  try {
    return { ok: true, value: JSON.parse(raw || '{}') };
  } catch (error) {
    return { ok: false, status: 400, error: error?.message || 'Invalid JSON body' };
  }
}

/**
 * Minimal fixed-window per-key limiter — the dev `makeRateLimiter` semantics,
 * minus the global backstop bookkeeping that assumed a single process. State
 * lives for the lifetime of one isolate.
 *
 * @param {{ windowMs: number, max: number, globalMax?: number }} opts
 * @returns {(key: string) => boolean}
 */
export function makeRateLimiter({ windowMs, max, globalMax }) {
  const hits = new Map();
  let globalTimes = [];
  return function allow(key) {
    const now = Date.now();
    globalTimes = globalTimes.filter((t) => now - t < windowMs);
    if (globalMax && globalTimes.length >= globalMax) return false;
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    globalTimes.push(now);
    return true;
  };
}

/**
 * Opt-in limiter: unset/0/non-numeric env → null (unlimited), exactly like the
 * dev `makeOptInRateLimiter`. Only a positive integer enables the 60 s window.
 *
 * @param {string|number|undefined} envValue
 * @returns {((key: string) => boolean)|null}
 */
export function makeOptInRateLimiter(envValue) {
  const max = Number(envValue);
  if (!Number.isFinite(max) || max <= 0) return null;
  return makeRateLimiter({ windowMs: 60_000, max: Math.floor(max), globalMax: Math.floor(max) * 20 });
}

/**
 * Cache an opt-in limiter the way the dev middlewares do: built on first use,
 * then REUSED so its per-IP window state survives across requests. Building a
 * fresh limiter per request would silently disable throttling — every request
 * would arrive with an empty window — so the cache is the behavior, not an
 * optimization. Keyed on the raw env value so a configuration change (or a
 * test) rebuilds cleanly.
 *
 * @returns {(envValue: string|number|undefined) => ((key: string) => boolean)|null}
 */
export function createCachedOptInLimiter() {
  let cachedKey;
  let cached;
  return (envValue) => {
    if (envValue !== cachedKey) {
      cachedKey = envValue;
      cached = makeOptInRateLimiter(envValue);
    }
    return cached;
  };
}

/**
 * Apply an opt-in limiter, writing the dev's exact 429 shape when over cap.
 *
 * @param {((key: string) => boolean)|null} limiter Null = unlimited.
 * @param {Request} request
 * @returns {boolean} True when the request may proceed.
 */
export function allowRequest(limiter, request) {
  if (!limiter) return true;
  return limiter(clientKey(request));
}

/** 429 response matching the dev middleware. */
export function rateLimitedResponse() {
  return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': '5',
    },
  });
}

/**
 * Client key for rate limiting. `CF-Connecting-IP` is set by the Cloudflare
 * edge to the real peer address and cannot be spoofed by the client — the
 * production analogue of the dev limiter's socket peer address. We
 * deliberately do NOT trust X-Forwarded-For here either.
 *
 * @param {Request} request
 * @returns {string}
 */
export function clientKey(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}
