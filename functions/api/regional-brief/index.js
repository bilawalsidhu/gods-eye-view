/**
 * Cloudflare Pages Function — /api/regional-brief
 *
 * Production counterpart of the dev middleware in
 * `vite/proxies/regional.js` (regional-brief-proxy): the cockpit's regional
 * briefing — reverse-geocoded place (Nominatim), current conditions
 * (Open-Meteo), and locality-matched headlines (Google News RSS with a GDELT
 * fallback). Both runtimes import the SAME worker-safe request-resolution
 * core (`resolveRegionalBriefRequest` in `src/data/regionalBriefPolicy.js`),
 * so this file is only the workerd adapter: Request/Response instead of
 * Connect's req/res, and a per-isolate limiter.
 *
 * This replaces the historical stub that always answered
 * `{ headlines: [], status: 'ok' }` — a shape that did not even match the
 * client contract (`src/data/regionalBrief.js` reads `payload.articles`), so
 * the Regional News page was permanently empty on Pages deployments.
 *
 * Contract (identical to dev — see the policy module for the full table):
 *   GET /api/regional-brief?latitude=…&longitude=…
 *     200 {status:'ready'|'partial'|'cached'|'stale', retrievedAt,
 *          coordinates, place, placeStatus, weather, weatherStatus,
 *          newsStatus, newsQuery, newsSource, articles}
 *          with X-Regional-Brief: HIT | INFLIGHT | MISS | STALE
 *     400 {error:'Valid latitude and longitude are required'}
 *     405 {error:'Method Not Allowed'}
 *     429 {error:'Rate limit exceeded'}   (Retry-After: 10)
 *     503 {error:'Regional briefing is temporarily unavailable'}
 *
 * Honesty note (same as every Pages proxy): the limiter, the 0.1° cache and
 * the Nominatim pacing queue here are per-isolate module state — a backstop,
 * not a global quota. Upstream budgets (Nominatim 1 req/s) are primarily
 * held by the caching + single-flight behavior of the shared core.
 */
import { clientKey, makeRateLimiter } from '../../_lib.js';
import { resolveRegionalBriefRequest } from '../../../src/data/regionalBriefPolicy.js';

/** @type {Map<string, {payload: object, cachedAt: number}>} 0.1° key → payload. */
const cache = new Map();
/** @type {Map<string, Promise<object>>} single-flight per 0.1° key. */
const inFlight = new Map();

/** Per-isolate limiter — same limits as the dev middleware. */
const regionalBriefLimiter = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 90 });

export async function onRequest({ request }) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!regionalBriefLimiter(clientKey(request))) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '10' },
    });
  }
  const outcome = await resolveRegionalBriefRequest({
    method: request.method,
    searchParams: new URL(request.url).searchParams,
    cache,
    inFlight,
  });
  const headers = { 'Content-Type': 'application/json' };
  if (outcome.cacheControl) headers['Cache-Control'] = outcome.cacheControl;
  if (outcome.cacheState !== 'NONE') headers['X-Regional-Brief'] = outcome.cacheState;
  return new Response(JSON.stringify(outcome.payload), { status: outcome.status, headers });
}
