import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { fetchRegionalWeather } from './weather.js';
import { validRegionalPoint } from './query.js';
import { coalesceProxyRequest } from '../common/http.js';

const WEATHER_EFFECTS_CACHE_MS = 5 * 60_000;

const WEATHER_EFFECTS_STALE_MS = 30 * 60_000;

const WEATHER_EFFECTS_MAX_CACHE = 180;

const _weatherEffectsCache = new Map();

const _weatherEffectsInFlight = new Map();

const _weatherEffectsRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 45,
  globalMax: 120,
});

function trimWeatherEffectsCache() {
  while (_weatherEffectsCache.size > WEATHER_EFFECTS_MAX_CACHE) {
    const oldest = _weatherEffectsCache.keys().next().value;
    if (oldest === undefined) break;
    _weatherEffectsCache.delete(oldest);
  }
}

function weatherEffectsProxy() {
  async function refresh(point, key) {
    const weather = await fetchRegionalWeather(point);
    if (!weather) throw new Error('Weather observation unavailable');
    const payload = {
      status: 'ready',
      retrievedAt: new Date().toISOString(),
      coordinates: point,
      weather,
    };
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
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const point = validRegionalPoint(url.searchParams);
      if (!point) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Valid latitude and longitude are required',
          }),
        );
        return;
      }
      const key = `${(Math.round(point.latitude * 10) / 10).toFixed(1)},${(Math.round(point.longitude * 10) / 10).toFixed(1)}`;
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
      const request = coalesceProxyRequest(_weatherEffectsInFlight, key, () =>
        refresh(point, key),
      );
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
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'Weather effects are temporarily unavailable',
          }),
        );
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

export { weatherEffectsProxy };
