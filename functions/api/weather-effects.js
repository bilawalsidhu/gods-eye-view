/**
 * Cloudflare Pages Function — /api/weather-effects
 *
 * Production counterpart of the dev middleware in
 * `vite/proxies/regional.js` (weather-effects-proxy): camera-local
 * observations for the cockpit cloud/precip effects, fetched from the keyless
 * Open-Meteo forecast API and normalized by the shared
 * `src/data/regionalBrief.js` normalizer. Validation, the 0.1° cache-key
 * quantization, TTLs and the payload shape live in the shared
 * `src/data/weatherEffectsPolicy.js` so the runtimes cannot drift.
 *
 * Contract (identical to dev):
 *   GET /api/weather-effects?latitude=…&longitude=…
 *     200 {status:'ready'|'cached'|'stale', retrievedAt, coordinates, weather}
 *         with X-Weather-Effects: HIT | INFLIGHT | MISS | STALE
 *     400 {error:'Valid latitude and longitude are required'}
 *     405 {error:'Method Not Allowed'}
 *     429 {error:'Rate limit exceeded'}   (Retry-After: 10)
 *     503 {error:'Weather effects are temporarily unavailable'}
 */
import { clientKey, makeRateLimiter } from '../_lib.js';
import { normalizeRegionalWeather } from '../../src/data/regionalBrief.js';
import {
  WEATHER_EFFECTS_CACHE_MS,
  WEATHER_EFFECTS_MAX_CACHE,
  WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
  WEATHER_EFFECTS_STALE_MS,
  buildOpenMeteoWeatherUrl,
  buildWeatherEffectsPayload,
  validRegionalPoint,
  regionalPointCacheKey,
} from '../../src/data/weatherEffectsPolicy.js';

/** @type {Map<string, {payload: object, cachedAt: number}>} 0.1° key → payload. */
const mem = new Map();
/** @type {Map<string, Promise<object>>} single-flight per 0.1° key. */
const inflight = new Map();

/** Per-isolate limiter — same limits as the dev middleware. */
const weatherEffectsLimiter = makeRateLimiter({ windowMs: 60_000, max: 45, globalMax: 120 });

export async function onRequest({ request }) {
  const sendJson = (status, bodyObj, extraHeaders = {}) => new Response(JSON.stringify(bodyObj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
  try {
    if (request.method !== 'GET') {
      return sendJson(405, { error: 'Method Not Allowed' });
    }
    if (!weatherEffectsLimiter(clientKey(request))) {
      return sendJson(429, { error: 'Rate limit exceeded' }, { 'Retry-After': '10' });
    }
    const point = validRegionalPoint(new URL(request.url).searchParams);
    if (!point) {
      return sendJson(400, { error: 'Valid latitude and longitude are required' });
    }

    const key = regionalPointCacheKey(point);
    const now = Date.now();
    const cached = mem.get(key);
    if (cached && now - cached.cachedAt <= WEATHER_EFFECTS_CACHE_MS) {
      return sendJson(200, { ...cached.payload, status: 'cached' }, {
        'Cache-Control': 'public, max-age=60',
        'X-Weather-Effects': 'HIT',
      });
    }

    const shared = inflight.has(key);
    if (!shared) {
      const pending = refresh(point, key).finally(() => {
        if (inflight.get(key) === pending) inflight.delete(key);
      });
      inflight.set(key, pending);
    }
    try {
      const payload = await inflight.get(key);
      return sendJson(200, payload, {
        'Cache-Control': 'public, max-age=60',
        'X-Weather-Effects': shared ? 'INFLIGHT' : 'MISS',
      });
    } catch {
      // Refresh failed: a last-good observation beats an empty layer.
      const stale = mem.get(key);
      if (stale && now - stale.cachedAt <= WEATHER_EFFECTS_STALE_MS) {
        return sendJson(200, { ...stale.payload, status: 'stale' }, {
          'Cache-Control': 'no-store',
          'X-Weather-Effects': 'STALE',
        });
      }
      return sendJson(503, { error: 'Weather effects are temporarily unavailable' }, {
        'Cache-Control': 'no-store',
      });
    }
  } catch (err) {
    console.warn('[/api/weather-effects]', err?.message || err);
    return sendJson(503, { error: 'Weather effects are temporarily unavailable' }, {
      'Cache-Control': 'no-store',
    });
  }
}

/**
 * Fetch + normalize one observation, cache it, and trim the cache ceiling —
 * mirrors the dev middleware's refresh() step.
 */
async function refresh(point, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  let payload;
  try {
    const response = await fetch(buildOpenMeteoWeatherUrl(point), { signal: controller.signal });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    const text = await response.text();
    if (new TextEncoder().encode(text).length > WEATHER_EFFECTS_MAX_RESPONSE_BYTES) {
      throw new Error('Upstream response too large');
    }
    const weather = normalizeRegionalWeather(JSON.parse(text));
    if (!weather) throw new Error('Weather observation unavailable');
    payload = buildWeatherEffectsPayload(point, weather, new Date().toISOString());
  } finally {
    clearTimeout(timer);
  }
  mem.set(key, { payload, cachedAt: Date.now() });
  while (mem.size > WEATHER_EFFECTS_MAX_CACHE) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
  return payload;
}

/** Test seam: the cache/limiter is module-scoped per isolate. */
export function resetWeatherEffectsStateForTest() {
  mem.clear();
  inflight.clear();
}

/** Test seam: age one cached point past the TTL without waiting 5 minutes. */
export function expireWeatherEffectsPointForTest(key) {
  const entry = mem.get(key);
  if (entry) entry.cachedAt = Date.now() - WEATHER_EFFECTS_CACHE_MS - 1;
}
