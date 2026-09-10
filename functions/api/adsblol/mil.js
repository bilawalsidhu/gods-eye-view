// functions/api/adsblol/mil.js
/**
 * `/api/adsblol/mil` — Cloudflare Pages Function.
 *
 * Production counterpart of the dev middleware in `vite.config.js`
 * (adsbLolProxy). adsb.lol sends no CORS headers, so both
 * `src/data/militaryFlights.js` (layer poll) and `src/data/militaryRegistry.js`
 * (known-military registry refresh) read the military fleet through this
 * same-origin proxy of GET https://api.adsb.lol/v2/mil.
 *
 * Contract (identical to dev): NO method guard and NO query params — the dev
 * middleware checks neither, and `militaryRegistry.js` relies on plain GET.
 *   200 + `X-ADS-B-Cache: HIT`   `Cache-Control: no-store` — served from the
 *                                12 s cache
 *   <upstream status> + `MISS`   `Cache-Control: no-store` — proxied verbatim;
 *                                a non-2xx upstream body IS surfaced here
 *                                (unlike the track routes) but NOT cached, so
 *                                the next request retries upstream
 *   200 + `X-ADS-B-Cache: STALE` upstream threw and a cached body exists —
 *                                note this branch sets NO Cache-Control, the
 *                                one header asymmetry in the dev middleware
 *   502 {"error":"ADS-B proxy error"}  upstream threw with nothing cached; no
 *                                `X-ADS-B-Cache` header on this branch
 *
 * Caching: a single 12 s slot (`CACHE_MS`), only filled by a 2xx upstream. The
 * response body is cached as a string with no size cap — v2/mil is bounded by
 * the size of the world's military fleet, and the dev middleware applies no cap
 * either. Per-isolate memory, so a recycled isolate serves a MISS/502 rather
 * than a stale body until one upstream request lands.
 *
 * Honest note: no explicit upstream timeout. The dev middleware sets none
 * (unlike every other proxy in this directory), and adding one would change
 * which failures surface to the client — workerd's own fetch deadline is the
 * backstop instead.
 *
 * Test-only export: `resetMilCacheForTest()` clears the per-isolate slot so a
 * test file can exercise the cold and warm paths deterministically. No
 * production path calls it.
 */

/** Response cache TTL (ms). */
const CACHE_MS = 12000;

/** @type {string|null} Cached upstream JSON body. */
let _cache = null;
/** @type {number} Epoch-ms when the cache was populated. */
let _cacheAt = 0;

function json(status, body, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/**
 * Test-only cache reset — see the module docblock.
 * @returns {void}
 */
export function resetMilCacheForTest() {
  _cache = null;
  _cacheAt = 0;
}

// No `request` is read here — the dev middleware ignores `req` entirely (no
// method check, no params, no cache key), so the Function does too.
export async function onRequest() {
  try {
    const now = Date.now();
    if (_cache && now - _cacheAt < CACHE_MS) {
      return json(200, _cache, { 'Cache-Control': 'no-store', 'X-ADS-B-Cache': 'HIT' });
    }
    const upstream = await fetch('https://api.adsb.lol/v2/mil', {
      headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
    });
    const body = await upstream.text();
    if (upstream.ok) {
      _cache = body;
      _cacheAt = now;
    }
    return json(upstream.status, body, { 'Cache-Control': 'no-store', 'X-ADS-B-Cache': 'MISS' });
  } catch (error) {
    console.error('[adsb.lol Proxy]', error?.message || error);
    if (_cache) {
      return json(200, _cache, { 'X-ADS-B-Cache': 'STALE' });
    }
    return json(502, JSON.stringify({ error: 'ADS-B proxy error' }));
  }
}
