import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { fetchRegionalPlace } from './place.js';
import { fetchRegionalWeather } from './weather.js';
import { fetchRegionalNews } from './news.js';
import { validRegionalPoint } from './query.js';
import { coalesceProxyRequest } from '../common/http.js';
import { createDmhObservationSource } from './dmh.js';
import {
  isRecentDmhObservation,
  regionalDistanceM,
} from '../../../src/data/regionalModel.js';

// ---------------------------------------------------------------------------
// Regional cockpit briefing proxy
// ---------------------------------------------------------------------------
const REGIONAL_BRIEF_CACHE_MS = 5 * 60_000;

const REGIONAL_BRIEF_STALE_MS = 60 * 60_000;

const REGIONAL_BRIEF_MAX_CACHE = 120;

// Brief cells span 0.1 degrees; recalculate station distance for the actual
// request and do not carry an expired reading through the one-hour fallback.
function withCurrentObservation(payload, point) {
  const observation = payload.stationObservation;
  if (!observation) return payload;
  const distanceM = regionalDistanceM(point, observation);
  if (!isRecentDmhObservation(observation) || distanceM > 50_000) {
    return {
      ...payload,
      stationObservation: null,
      stationObservationStatus: 'no-recent-station',
    };
  }
  return { ...payload, stationObservation: { ...observation, distanceM } };
}

/** True when at least one regional source produced usable data. */
function regionalBriefHasAnySource({
  place,
  weather,
  news,
  stationObservation,
} = {}) {
  return Boolean(
    place ||
    weather ||
    stationObservation ||
    (news && news.status !== 'unavailable'),
  );
}

function regionalBriefProxy({
  placeProvider = fetchRegionalPlace,
  weatherProvider = fetchRegionalWeather,
  newsProvider = fetchRegionalNews,
  dmhProvider = createDmhObservationSource().getObservation,
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
    const [placeResult, weatherResult, dmhResult] = await Promise.allSettled([
      placeProvider(point),
      weatherProvider(point),
      dmhProvider(point),
    ]);
    const place = placeResult.status === 'fulfilled' ? placeResult.value : null;
    const weather =
      weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const dmh =
      dmhResult.status === 'fulfilled'
        ? dmhResult.value
        : { status: 'unavailable', observation: null };
    const stationObservation = dmh?.observation ?? null;
    const news = await newsProvider(place);
    if (
      !regionalBriefHasAnySource({ place, weather, news, stationObservation })
    ) {
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
      stationObservation,
      stationObservationStatus: dmh?.status || 'unavailable',
      newsStatus: news.status,
      newsQuery: news.query,
      newsSource: news.source,
      articles: news.articles,
    };
    _regionalBriefCache.set(key, { payload, cachedAt: Date.now() });
    trimRegionalBriefCache();
    return payload;
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
      if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_CACHE_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          'X-Regional-Brief': 'HIT',
        });
        res.end(
          JSON.stringify(
            withCurrentObservation(
              { ...cached.payload, status: 'cached' },
              point,
            ),
          ),
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
        res.end(JSON.stringify(withCurrentObservation(payload, point)));
      } catch {
        if (cached && now - cached.cachedAt <= REGIONAL_BRIEF_STALE_MS) {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Regional-Brief': 'STALE',
          });
          res.end(
            JSON.stringify(
              withCurrentObservation(
                { ...cached.payload, status: 'stale' },
                point,
              ),
            ),
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
