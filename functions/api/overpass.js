// functions/api/overpass.js
/**
 * Cloudflare Pages Function — `/api/overpass`
 *
 * The production counterpart of the dev middleware in `vite.config.js`
 * (overpassProxy). Both runtimes share ONE policy + transport implementation —
 * `src/data/overpassPolicy.js` — so what may be sent upstream and what may be
 * buffered back cannot drift between dev and Pages.
 *
 * Contract (identical to dev):
 *   405 {error:'Method Not Allowed'}              — anything but POST
 *   413 {error:'Overpass query too large'}        — body > 24 KB
 *   400 {error:'Missing Overpass query body'}     — empty body
 *   400 {error: <sanitizer message>}              — unbounded/oversized/illegal QL
 *   429 {error:'Rate limit exceeded'} + Retry-After: 5
 *   503 {error:'Overpass proxy busy — try again shortly'} + Retry-After: 2
 *   502 {error:'Overpass proxy error'}            — every mirror failed
 *   upstream status verbatim otherwise, with `X-Overpass-Cache` (HIT/INFLIGHT/
 *   MISS/STALE) and `X-Overpass-Upstream` headers and `Cache-Control:
 *   public, max-age=15`.
 *
 * Honest runtime difference (documented in SECURITY.md): the dev middleware
 * also keeps a 7/30-day DISK cache layer for restarts; workerd has no `fs`, so
 * Pages serves from the per-isolate memory cache and single-flight map only.
 * CORS is deliberately unset, matching dev — the client is same-origin.
 */
import { clientKey, makeRateLimiter } from '../_lib.js';
import {
  fetchOverpassPayload,
  OVERPASS_MAX_RESPONSE_BYTES,
  sanitizeOverpassBody,
} from '../../src/data/overpassPolicy.js';

/** Body cap — dev parity (Overpass QL queries are tiny). */
const OVERPASS_MAX_BODY_BYTES = 24 * 1024;
/** Fresh-response TTL (ms) — dev parity. */
const CACHE_MS = 86_400_000;
/** Max entries in the response cache (LRU-like, oldest evicted first). */
const CACHE_MAX_ENTRIES = 120;
/** Max concurrent in-flight upstream fetches — dev parity. */
const MAX_CONCURRENT = 6;
/** Dev limiter limits: 90/min per client, 300/min global backstop. */
let rateLimiter = makeRateLimiter({ windowMs: 60_000, max: 90, globalMax: 300 });

/** @type {Map<string,{status:number,body:string,contentType:string,endpoint:string,cachedAt:number}>} */
const responseCache = new Map();
/** @type {Map<string,Promise>} In-flight upstream requests keyed by normalized query body. */
const inFlight = new Map();
let concurrent = 0;

/** Test-only: clear every module-level cache/counter so tests start cold. */
export function resetOverpassStateForTest() {
  responseCache.clear();
  inFlight.clear();
  concurrent = 0;
  rateLimiter = makeRateLimiter({ windowMs: 60_000, max: 90, globalMax: 300 });
}

function trimCache() {
  while (responseCache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = responseCache.keys().next().value;
    if (!oldestKey) break;
    responseCache.delete(oldestKey);
  }
}

/** Same response shape as the dev `sendOverpassResponse`. */
function overpassResponse(payload, cacheStatus) {
  return new Response(payload.body || '', {
    status: payload.status,
    headers: {
      'Content-Type': payload.contentType || 'application/json',
      'Cache-Control': 'public, max-age=15',
      'X-Overpass-Cache': cacheStatus,
      'X-Overpass-Upstream': payload.endpoint || 'unknown',
    },
  });
}

function jsonError(status, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

export async function onRequest({ request }) {
  if (request.method !== 'POST') {
    return jsonError(405, 'Method Not Allowed');
  }

  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).length > OVERPASS_MAX_BODY_BYTES) {
    return jsonError(413, 'Overpass query too large');
  }
  if (!rawBody) {
    return jsonError(400, 'Missing Overpass query body');
  }

  // Validate + clamp the QL: reject unbounded/global queries and cap the
  // server-side timeout so a tiny body can't request planet-scale work.
  const sanitized = sanitizeOverpassBody(rawBody);
  if (!sanitized.ok) return jsonError(400, sanitized.error);
  const safeBody = sanitized.body;

  // Normalize whitespace so semantically identical queries share cache entries.
  const cacheKey = safeBody.replace(/\s+/g, ' ').trim();

  // Memory tier, then single-flight join, before consuming limiter quota.
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt <= CACHE_MS) {
    return overpassResponse(cached, 'HIT');
  }
  const pending = inFlight.get(cacheKey);
  if (pending) {
    try {
      return overpassResponse(await pending, 'INFLIGHT');
    } catch {
      return degradedOrError(cached);
    }
  }
  if (!rateLimiter(clientKey(request))) {
    return jsonError(429, 'Rate limit exceeded', { 'Retry-After': '5' });
  }

  // Genuinely upstream-bound from here; a bounded concurrency cap keeps a
  // burst of viewport loads from holding 6 slow mirror connections per isolate.
  if (concurrent >= MAX_CONCURRENT) {
    return jsonError(503, 'Overpass proxy busy — try again shortly', { 'Retry-After': '2' });
  }
  concurrent += 1;
  const requestPromise = fetchOverpassPayload(safeBody, OVERPASS_MAX_RESPONSE_BYTES)
    .then((payload) => {
      if (payload.status < 500 && !payload.rateLimited && !payload.runtimeError) {
        responseCache.set(cacheKey, { ...payload, cachedAt: Date.now() });
        trimCache();
      }
      return payload;
    })
    .finally(() => {
      concurrent -= 1;
      inFlight.delete(cacheKey);
    });
  inFlight.set(cacheKey, requestPromise);

  try {
    const payload = await requestPromise;
    // Degraded upstream (rate-limited on every mirror / 5xx / runtime error):
    // last-good roads beat an empty layer — serve stale at any age (dev parity;
    // the dev disk tier adds restarts, this memory tier has no disk analogue).
    // Cold, dev forwards the degraded payload verbatim, so the degraded status
    // travels; 502 is reserved for a transport-level total failure.
    if ((payload.rateLimited || payload.runtimeError || payload.status >= 500) && cached) {
      return overpassResponse(cached, 'STALE');
    }
    return overpassResponse(payload, 'MISS');
  } catch {
    return degradedOrError(cached);
  }
}

/** Last-good answer at any age beats an empty layer; 502 only when cold. */
function degradedOrError(cached) {
  if (cached) return overpassResponse(cached, 'STALE');
  return jsonError(502, 'Overpass proxy error');
}
