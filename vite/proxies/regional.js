/**
 * Regional briefing (`/api/regional-brief`) and weather-effects (`/api/weather-effects`) proxies.
 *
 * Extracted verbatim from vite.config.js (Batch 4, PLAN.md) so each
 * endpoint can be unit-tested in isolation; vite.config.js assembles the
 * plugin list from these modules.
 *
 * The regional-brief endpoint is a thin Node adapter over the SAME
 * request-resolution core the production Pages Function uses
 * (`src/data/regionalBriefPolicy.js`), so dev and production cannot drift —
 * the historical local implementation (Nominatim pacing, RSS/GDELT news
 * chain, cache and stale-while-revalidate semantics) lives there now.
 */

import { clientKey, coalesceProxyRequest, makeRateLimiter } from './_shared.js';
import {
  REGIONAL_BRIEF_CACHE_MS,
  REGIONAL_BRIEF_STALE_MS,
  REGIONAL_BRIEF_MAX_CACHE,
  fetchRegionalWeather,
  regionalBriefHasAnySource,
  resolveRegionalBriefRequest,
  validRegionalPoint,
} from '../../src/data/regionalBriefPolicy.js';
import {
  WEATHER_EFFECTS_CACHE_MS,
  WEATHER_EFFECTS_MAX_CACHE,
  WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
  WEATHER_EFFECTS_STALE_MS,
  buildWeatherEffectsPayload,
  regionalPointCacheKey,
} from '../../src/data/weatherEffectsPolicy.js';

// Re-exported for the test suite and for callers that imported these names
// from this module before the regional-brief core moved into the
// worker-safe policy module.
export {
  REGIONAL_BRIEF_CACHE_MS,
  REGIONAL_BRIEF_STALE_MS,
  REGIONAL_BRIEF_MAX_CACHE,
  regionalBriefHasAnySource,
  validRegionalPoint,
};

// The weather-effects policy (validation, 0.1° cache key, upstream URL,
// payload shape, TTLs) lives in the worker-safe
// `src/data/weatherEffectsPolicy.js` so functions/api/weather-effects.js
// cannot drift from this middleware. Re-exported for the test suite.
export {
  WEATHER_EFFECTS_CACHE_MS,
  WEATHER_EFFECTS_MAX_RESPONSE_BYTES,
  WEATHER_EFFECTS_STALE_MS,
};

export const REGIONAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const _regionalBriefCache = new Map();

export const _regionalBriefInFlight = new Map();

export const _regionalBriefRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 90 });

export const _weatherEffectsCache = new Map();

export const _weatherEffectsInFlight = new Map();

export const _weatherEffectsRateLimiter = makeRateLimiter({ windowMs: 60_000, max: 45, globalMax: 120 });

export function trimRegionalBriefCache() {
  while (_regionalBriefCache.size > REGIONAL_BRIEF_MAX_CACHE) {
    const oldest = _regionalBriefCache.keys().next().value;
    if (oldest === undefined) break;
    _regionalBriefCache.delete(oldest);
  }
}

export function trimWeatherEffectsCache() {
  while (_weatherEffectsCache.size > WEATHER_EFFECTS_MAX_CACHE) {
    const oldest = _weatherEffectsCache.keys().next().value;
    if (oldest === undefined) break;
    _weatherEffectsCache.delete(oldest);
  }
}

export function regionalBriefProxy() {
  function install(middlewares) {
    middlewares.use('/api/regional-brief', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_regionalBriefRateLimiter(clientKey(req))) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '10' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const outcome = await resolveRegionalBriefRequest({
        method: req.method,
        searchParams: new URL(req.url || '', 'http://localhost').searchParams,
        cache: _regionalBriefCache,
        inFlight: _regionalBriefInFlight,
      });
      const headers = { 'Content-Type': 'application/json' };
      if (outcome.cacheControl) headers['Cache-Control'] = outcome.cacheControl;
      if (outcome.cacheState !== 'NONE') headers['X-Regional-Brief'] = outcome.cacheState;
      res.writeHead(outcome.status, headers);
      res.end(JSON.stringify(outcome.payload));
    });
  }

  return {
    name: 'regional-brief-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export function weatherEffectsProxy() {
  async function refresh(point, key) {
    const weather = await fetchRegionalWeather(point);
    if (!weather) throw new Error('Weather observation unavailable');
    const payload = buildWeatherEffectsPayload(point, weather, new Date().toISOString());
    _weatherEffectsCache.set(key, { payload, cachedAt: Date.now() });
    trimWeatherEffectsCache();
    return payload;
  }

  function install(middlewares) {
    middlewares.use('/api/weather-effects', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_weatherEffectsRateLimiter(clientKey(req))) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '10' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid latitude and longitude are required' }));
        return;
      }
      const key = regionalPointCacheKey(point);
      const now = Date.now();
      const cached = _weatherEffectsCache.get(key);
      if (cached && now - cached.cachedAt <= WEATHER_EFFECTS_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Weather-Effects': 'HIT',
        });
        res.end(JSON.stringify({ ...cached.payload, status: 'cached' }));
        return;
      }
      const request = coalesceProxyRequest(_weatherEffectsInFlight, key, () => refresh(point, key));
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Weather-Effects': request.shared ? 'INFLIGHT' : 'MISS',
        });
        res.end(JSON.stringify(payload));
      } catch {
        if (cached && now - cached.cachedAt <= WEATHER_EFFECTS_STALE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Weather-Effects': 'STALE',
          });
          res.end(JSON.stringify({ ...cached.payload, status: 'stale' }));
          return;
        }
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Weather effects are temporarily unavailable' }));
      }
    });
  }

  return {
    name: 'weather-effects-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
