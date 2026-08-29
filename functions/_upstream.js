// functions/_upstream.js
/**
 * Shared worker-safe port of the *upstream* proxy helpers that live in
 * `vite.config.js` on the dev side (`readCappedResponseText`,
 * `coalesceProxyRequest`, and the `trackBackfillProxies` response cache).
 *
 * `_lib.js` owns the request/response contract helpers; this module owns the
 * talking-to-upstream helpers. It exists because those dev helpers are defined
 * inside `vite.config.js`, which cannot be imported from a Worker (Node APIs,
 * `Buffer`, ~4k lines of plugin graph), and because duplicating them per
 * Function would silently fork the byte-cap and single-flight semantics the
 * client already depends on.
 *
 * Worker-safe only: `fetch`, `ReadableStream` readers and `TextDecoder` —
 * no `Buffer`, no `node:*` imports.
 *
 * @module functions/_upstream
 */

/**
 * Read an upstream response body as text under a hard byte cap, mirroring the
 * dev `readCappedResponseText` exactly:
 *   - a declared `content-length` over the cap short-circuits (body cancelled),
 *   - otherwise the stream is consumed chunk-by-chunk and aborted the moment
 *     the running total passes the cap,
 *   - `tooLarge` is reported instead of thrown (the track proxies answer with
 *     a sanitized error document; the launches proxy turns it into a throw).
 *
 * When the runtime hands us no stream reader we fall back to `response.text()`
 * and compare character count — the same approximation the dev helper makes.
 *
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<{tooLarge: boolean, text: string}>}
 */
export async function readTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel(); } catch { /* no-op */ }
    return { tooLarge: true, text: '' };
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return text.length > maxBytes ? { tooLarge: true, text: '' } : { tooLarge: false, text };
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* no-op */ }
      return { tooLarge: true, text: '' };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { tooLarge: false, text };
}

/**
 * Coalesce concurrent refreshes onto one upstream request — the dev
 * `coalesceProxyRequest`. The first caller owns the promise (`shared: false`);
 * every caller that lands while it is still pending joins it (`shared: true`),
 * which is how the launches proxy tells an `INFLIGHT` header from a `MISS`.
 *
 * @template T
 * @param {Map<string, Promise<T>>} inFlight Module-level map, owned by the caller.
 * @param {string} key
 * @param {() => Promise<T>} create
 * @returns {{promise: Promise<T>, shared: boolean}}
 */
export function coalesceRequest(inFlight, key, create) {
  const existing = inFlight.get(key);
  if (existing) return { promise: existing, shared: true };
  let promise;
  promise = Promise.resolve()
    .then(create)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return { promise, shared: false };
}

// --- Track-history backfill cache (`/api/opensky-track`, `/api/adsblol/trace`) ---

/** Per-key TTL (ms) — shared by BOTH track proxies, as on the dev side. */
export const TRACK_CACHE_MS = 60_000;
/** Oldest-entry eviction ceiling on the shared track cache. */
export const TRACK_CACHE_MAX = 200;
/** Hard cap on a single upstream track document (24 h of history is large). */
export const TRACK_RESPONSE_CAP_BYTES = 5 * 1024 * 1024;

/**
 * The single shared track response cache. On the dev side both track
 * middlewares close over ONE Map (keys `osky:<icao24>` / `lol:<hex>`), so a
 * busy aircraft evicts entries for the other source. Keeping one Map here too
 * is contract parity, not an optimization.
 *
 * Entries are cached REGARDLESS of upstream status: a 404 (unknown aircraft)
 * is replayed for the full TTL so a client re-clicking a plane does not burn
 * another OpenSky credit. Negative results age out with everything else.
 *
 * @type {Map<string, {at: number, status: number, body: string}>}
 */
const trackCache = new Map();

function trackCachePut(key, entry) {
  trackCache.set(key, entry);
  if (trackCache.size > TRACK_CACHE_MAX) {
    const oldest = [...trackCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) trackCache.delete(oldest[0]);
  }
}

/**
 * Shared body of the dev `proxyJson` for the two track backfill routes: check
 * the TTL cache, else fetch, cap the response, sanitize the error surface, and
 * cache whatever came back (any status). Throws on transport failure so the
 * caller can answer with its own route-specific 502 shape.
 *
 * @param {{key: string, upstreamUrl: string, headers?: Object<string,string>}} opts
 * @returns {Promise<{status: number, body: string, cacheHit: boolean}>}
 */
export async function fetchTrackJson({ key, upstreamUrl, headers = {} }) {
  const cached = trackCache.get(key);
  if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
    return { status: cached.status, body: cached.body, cacheHit: true };
  }
  const upstream = await fetch(upstreamUrl, { headers, signal: AbortSignal.timeout(12_000) });
  const { tooLarge, text } = await readTextCapped(upstream, TRACK_RESPONSE_CAP_BYTES);
  let body;
  if (tooLarge) {
    body = JSON.stringify({ error: 'Upstream track response too large' });
  } else if (!upstream.ok) {
    // Sanitize upstream error surface; status code is signal enough.
    body = JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
  } else {
    body = text;
  }
  trackCachePut(key, { at: Date.now(), status: upstream.status, body });
  return { status: upstream.status, body, cacheHit: false };
}

/**
 * The one response shape both track routes answer with. Note it is applied to
 * cache hits, sanitized errors and successful passthroughs alike — the dev
 * middleware sets these two headers on every `proxyJson` exit.
 *
 * @param {number} status
 * @param {string} body
 * @returns {Response}
 */
export function trackResponse(status, body) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Test-only: drop every cached track entry so a test file can exercise the
 * cold path deterministically. No production code path calls this.
 *
 * @returns {void}
 */
export function resetTrackCacheForTest() {
  trackCache.clear();
}
