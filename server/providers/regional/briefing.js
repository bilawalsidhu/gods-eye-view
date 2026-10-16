import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { fetchRegionalPlace } from './place.js';
import { createRegionalBriefWeatherProvider } from './weather.js';
import { smnWeatherAtPoint } from './smn-model.js';
import { isSmnCoveragePoint } from './smn.js';
import { fetchRegionalNews } from './news.js';
import { validRegionalPoint } from './query.js';
import { coalesceProxyRequest } from '../common/http.js';

// ---------------------------------------------------------------------------
// Regional cockpit briefing proxy
// ---------------------------------------------------------------------------
const REGIONAL_BRIEF_CACHE_MS = 5 * 60_000;

const REGIONAL_BRIEF_STALE_MS = 60 * 60_000;

const REGIONAL_BRIEF_MAX_CACHE = 120;

/** True when at least one regional source produced usable data. */
function regionalBriefHasAnySource({ place, weather, news } = {}) {
  return Boolean(place || weather || (news && news.status !== 'unavailable'));
}

function regionalBriefProxy({
  placeProvider = fetchRegionalPlace,
  weatherProvider = createRegionalBriefWeatherProvider(),
} = {}) {
  const _regionalBriefCache = new Map();

  const _regionalBriefInFlight = new Map();

  const _regionalBriefRateLimiter = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 90,
  });

  function trimRegionalBriefCache() {
    while (_regionalBriefCache.size > REGIONAL_BRIEF_MAX_CACHE) {
      const oldest = _regionalBriefCache.keys().next().value;
      if (oldest === undefined) break;
      _regionalBriefCache.delete(oldest);
    }
  }

  async function refresh(point, key) {
    const [placeResult, weatherResult] = await Promise.allSettled([
      placeProvider(point),
      weatherProvider(point),
    ]);
    const place = placeResult.status === 'fulfilled' ? placeResult.value : null;
    const weather =
      weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const news = await fetchRegionalNews(place);
    if (!regionalBriefHasAnySource({ place, weather, news })) {
      throw new Error('All regional briefing sources unavailable');
    }
    const payload = {
      status:
        place && weather && news.status !== 'unavailable' ? 'ready' : 'partial',
      retrievedAt: new Date().toISOString(),
      coordinates: point,
      place,
      placeStatus: place ? 'ready' : 'unavailable',
      weather,
      weatherStatus: weather ? 'ready' : 'unavailable',
      newsStatus: news.status,
      newsQuery: news.query,
      newsSource: news.source,
      articles: news.articles,
    };
    _regionalBriefCache.set(key, { payload, cachedAt: Date.now() });
    trimRegionalBriefCache();
    return payload;
  }

  async function weatherForPoint(entry, point) {
    if (!isSmnCoveragePoint(point) && entry.payload.weather?.source !== 'smn')
      return entry.payload.weather;
    try {
      const weather = await weatherProvider(point, entry.payload.weather);
      // Retain a model fallback for this cell without caching a station choice.
      if (weather && weather.source !== 'smn') entry.payload.weather = weather;
      return weather;
    } catch {
      return null;
    }
  }

  function install(middlewares) {
    middlewares.use('/api/regional-brief', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_regionalBriefRateLimiter(clientKey(req))) {
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
      const cached = _regionalBriefCache.get(key);
      const fresh = cached && now - cached.cachedAt <= REGIONAL_BRIEF_CACHE_MS;
      const cachedWeather = fresh
        ? await weatherForPoint(cached, point)
        : cached?.payload.weather;
      if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Regional-Brief': 'HIT',
        });
        res.end(
          JSON.stringify({
            ...cached.payload,
            coordinates: point,
            weather: cachedWeather,
            weatherStatus: cachedWeather ? 'ready' : 'unavailable',
            status: 'cached',
          }),
        );
        return;
      }
      const request = coalesceProxyRequest(_regionalBriefInFlight, key, () =>
        refresh(point, key),
      );
      try {
        const payload = await request.promise;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Regional-Brief': request.shared ? 'INFLIGHT' : 'MISS',
        });
        // Coalesced requests can be in the same cell but nearer different stations.
        const weather =
          payload.coordinates.latitude === point.latitude &&
          payload.coordinates.longitude === point.longitude
            ? payload.weather
            : await weatherForPoint({ payload }, point);
        res.end(
          JSON.stringify({
            ...payload,
            coordinates: point,
            weather,
            weatherStatus: weather ? 'ready' : 'unavailable',
          }),
        );
      } catch {
        if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_STALE_MS) {
          const staleWeather =
            cached.payload.weather?.source === 'smn'
              ? smnWeatherAtPoint(cached.payload.weather, point)
              : cachedWeather;
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Regional-Brief': 'STALE',
          });
          res.end(
            JSON.stringify({
              ...cached.payload,
              coordinates: point,
              weather: staleWeather,
              weatherStatus: staleWeather ? 'ready' : 'unavailable',
              status: 'stale',
            }),
          );
          return;
        }
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            error: 'Regional briefing is temporarily unavailable',
          }),
        );
      }
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

export { regionalBriefHasAnySource, regionalBriefProxy };
