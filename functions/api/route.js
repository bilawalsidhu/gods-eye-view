/**
 * Cloudflare Pages Function — /api/route
 *
 * Production counterpart of the dev `/api/route` middleware in
 * `vite/proxies/overpass.js`. Real OSM routing via the public FOSSGIS OSRM
 * servers (foot/car/bike), shared policy in `src/data/routePolicy.js` so the
 * two runtimes cannot drift (same validation, error strings, upstream URL).
 *
 * Contract (identical to dev):
 *   GET /api/route?profile=foot|car|bike&coords=lon,lat;lon,lat[;…]
 *     200 {ok:true, profile, distanceM, durationS, geometry}
 *     200 {ok:false, error:'…'}          ← all validation/routing failures
 *     429 {ok:false, error:'rate limited'}
 *
 * Cache + abuse guards mirror the dev middleware: 10 min per-route memory
 * cache (200 entries max), 60 req/min/IP limiter, 2-12 coordinate cap,
 * leg/total span caps so nobody drives expensive cross-continent upstream
 * work. Workers are multi-isolate, so module state here is per-isolate — a
 * backstop, not a global quota (same honesty note as functions/_lib.js).
 */
import { clientKey, jsonResponse, makeRateLimiter } from '../_lib.js';
import {
  ROUTE_CACHE_MAX_ENTRIES,
  ROUTE_CACHE_MS,
  ROUTE_MAX_RESPONSE_BYTES,
  ROUTE_UPSTREAM_TIMEOUT_MS,
  buildOsrmUrl,
  normalizeRouteProfile,
  osrmRoutePayload,
  parseRouteCoords,
  routeSpanError,
} from '../../src/data/routePolicy.js';

/** @type {Map<string, {payload: object, cachedAt: number}>} profile|coords → payload. */
const routeCache = new Map();

/** Per-isolate fixed-window limiter — same limits as the dev middleware. */
const routeLimiter = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 200 });

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const fail = (msg) => jsonResponse({ ok: false, error: msg });
  try {
    if (!routeLimiter(clientKey(request))) {
      return new Response(JSON.stringify({ ok: false, error: 'rate limited' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '5' },
      });
    }
    const url = new URL(request.url);
    const profile = normalizeRouteProfile(url.searchParams.get('profile'));
    if (!profile) return fail('invalid profile');
    const parsed = parseRouteCoords(url.searchParams.get('coords'));
    if (!parsed.ok) return fail(parsed.error);
    const spanError = routeSpanError(parsed.pts);
    if (spanError) return fail(spanError);

    const cacheKey = `${profile}|${parsed.coords}`;
    const now = Date.now();
    const cached = routeCache.get(cacheKey);
    if (cached && now - cached.cachedAt <= ROUTE_CACHE_MS) {
      return jsonResponse(cached.payload);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROUTE_UPSTREAM_TIMEOUT_MS);
    let osrm;
    try {
      const upstreamRes = await fetch(buildOsrmUrl(profile, parsed.coords), {
        signal: controller.signal,
        headers: { 'User-Agent': 'gods-eye-view/pages (cloudflare)' },
      });
      if (!upstreamRes.ok) return fail('no route found');
      const ctype = upstreamRes.headers.get('content-type') || '';
      if (!ctype.includes('json')) return fail('no route found');
      const text = await upstreamRes.text();
      if (new TextEncoder().encode(text).length > ROUTE_MAX_RESPONSE_BYTES) return fail('no route found');
      osrm = JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }

    const payload = osrmRoutePayload(osrm, profile);
    if (!payload.ok) return fail(payload.error);
    routeCache.set(cacheKey, { payload, cachedAt: now });
    if (routeCache.size > ROUTE_CACHE_MAX_ENTRIES) {
      routeCache.delete(routeCache.keys().next().value);
    }
    return jsonResponse(payload);
  } catch (err) {
    console.warn('[/api/route]', err?.message || err);
    return jsonResponse({ ok: false, error: 'route proxy error' });
  }
}

/** Test seam: the cache/limiter is module-scoped per isolate. */
export function resetRouteStateForTest() {
  routeCache.clear();
}
