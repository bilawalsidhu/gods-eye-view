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

/**
 * Security headers every API response carries. Cloudflare Pages applies
 * `public/_headers` to STATIC assets only — Pages Function responses set
 * their own headers — so the nosniff the `/api/*` rule documents has to be
 * set here to be real in production (verified via `wrangler pages dev`:
 * function responses carried only what the function itself set). Stamped
 * on every response by `functions/_middleware.js` and by the shared
 * helpers below for anything that bypasses the middleware in tests.
 */
export const API_SECURITY_HEADERS = { 'X-Content-Type-Options': 'nosniff' };

/** JSON response with the same headers the dev middlewares set, plus the
 *  API security headers above. */
export function jsonResponse(data, { status = 200, cacheControl = null } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...API_SECURITY_HEADERS };
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
 * Default Pages throttles (requests/min/IP) for the cost-bearing endpoints —
 * the values `createDefaultOnRateLimiter` applies when no `GEV_RATELIMIT_*`
 * env is configured. Generous for a human driving the app (a HUD summary
 * refreshes ~1×/min; voice token minting is per session), tight enough that a
 * drive-by script cannot meaningfully burn quota. Override per deployment via
 * the env knobs; `0` disables.
 */
export const PAGES_RATELIMIT_OPENAI_PER_MIN = 30;
export const PAGES_RATELIMIT_GOOGLE_PER_MIN = 60;

/**
 * Cache a PAGES limiter: default-ON where the dev middleware is opt-in.
 *
 * A Pages deployment is a public URL, so a cost-bearing endpoint with no
 * `GEV_RATELIMIT_*` configured must not be unlimited — the default throttle
 * (per-IP 60 s window, global backstop at 20× the per-IP cap) applies unless
 * the operator overrides it:
 *
 *   - env unset / empty        → `defaultPerMin` (the point of this factory)
 *   - env a positive integer   → that many requests/min/IP (override)
 *   - env `0` (or any other    → null = unlimited (documented escape hatch;
 *     non-positive value)        also the dev opt-in semantics)
 *
 * Same caching discipline as `createCachedOptInLimiter`: keyed on the raw env
 * value, rebuilt only when it changes, reused otherwise.
 *
 * @param {number} defaultPerMin Requests/min/IP when the env is unset.
 * @returns {(envValue: string|number|undefined) => ((key: string) => boolean)|null}
 */
export function createDefaultOnRateLimiter(defaultPerMin) {
  // Sentinel (not `undefined`): an UNSET env is a real cache state (the
  // default-ON limiter), so the very first call must take the rebuild branch
  // rather than "matching" an uninitialized key.
  const UNSET = Symbol('unset');
  let cachedKey = UNSET;
  let cached;
  return (envValue) => {
    if (envValue !== cachedKey) {
      cachedKey = envValue;
      const override = Number(envValue);
      if (Number.isFinite(override) && override > 0) {
        cached = makeRateLimiter({
          windowMs: 60_000,
          max: Math.floor(override),
          globalMax: Math.floor(override) * 20,
        });
      } else if (envValue === undefined || envValue === null || envValue === '') {
        cached = makeRateLimiter({
          windowMs: 60_000,
          max: defaultPerMin,
          globalMax: defaultPerMin * 20,
        });
      } else {
        cached = null;
      }
    }
    return cached;
  };
}

/** Host of a URL string, '' when unparseable (an invalid Origin never matches). */
export function hostOf(value) {
  try {
    return new URL(value).host;
  } catch {
    return '';
  }
}

/**
 * Same-site guard for the cost-bearing endpoints — the shared shape of the
 * `Origin` check the realtime token Function already applied, extended to the
 * GET endpoints that carry no Origin header.
 *
 * Browsers attach `Origin` to every POST (and every cross-origin request):
 * a POST whose Origin host differs from the request host is a cross-site
 * drive-by (some other web page spending this deployment's API quota through
 * a visitor's browser) and is rejected. GET fetches carry no Origin, so the
 * guard falls back to `Sec-Fetch-Site`, which every modern browser attaches:
 * anything other than `same-origin` or `none` (direct navigation) is
 * rejected. Absent headers mean a non-browser client (curl, agents) — those
 * cannot be distinguished from same-origin traffic and are allowed, subject
 * to the rate limiter.
 *
 * @param {Request} request
 * @returns {?string} 'cross-origin' | 'cross-site' when the request must be
 *   rejected, null when it may proceed.
 */
export function sameSiteViolation(request) {
  const origin = request.headers.get('Origin');
  if (origin) {
    return hostOf(origin) === hostOf(request.url) ? null : 'cross-origin';
  }
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin' && site !== 'none') return 'cross-site';
  return null;
}

/**
 * The 403 both runtimes answer a same-site violation with. The google
 * endpoints append their `places: []` contract field themselves.
 *
 * @returns {Response}
 */
export function sameSiteRejection() {
  return jsonResponse({ error: 'cross-origin requests are rejected' }, { status: 403 });
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
      ...API_SECURITY_HEADERS,
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
