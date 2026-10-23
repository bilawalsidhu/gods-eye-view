import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { fetchRegionalPlace } from './place.js';
import { createRegionalBriefWeatherProvider } from './weather.js';
import { smnWeatherAtPoint } from './smn-model.js';
import { isSmnCoveragePoint } from './smn.js';
import { fetchRegionalNews } from './news.js';
import { validRegionalPoint } from './query.js';
import { coalesceProxyRequest } from '../common/http.js';
import { createDmhObservationSource, isDmhCoveragePoint } from './dmh.js';
import {
  isRecentDmhObservation,
  regionalDistanceM,
} from '../../../src/data/regionalModel.js';

const REGIONAL_BRIEF_CACHE_MS = 5 * 60_000;
const REGIONAL_BRIEF_STALE_MS = 60 * 60_000;
const REGIONAL_BRIEF_MAX_CACHE = 120;

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

function currentDmh(result, point) {
  if (!isDmhCoveragePoint(point))
    return { status: 'outside-coverage', observation: null };
  const observation = result?.observation;
  if (!observation)
    return { status: result?.status || 'unavailable', observation: null };
  const distanceM = regionalDistanceM(point, observation);
  if (
    !isRecentDmhObservation(observation) ||
    !Number.isFinite(distanceM) ||
    distanceM > 50_000
  )
    return { status: 'no-recent-station', observation: null };
  return { status: 'ready', observation: { ...observation, distanceM } };
}

function regionalBriefProxy({
  placeProvider = fetchRegionalPlace,
  weatherProvider = createRegionalBriefWeatherProvider(),
  newsProvider = fetchRegionalNews,
  dmhProvider = createDmhObservationSource().getObservation,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const models = new Map();
  const modelInFlight = new Map();
  const rateLimiter = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 90,
  });

  function trim(map) {
    while (map.size > REGIONAL_BRIEF_MAX_CACHE)
      map.delete(map.keys().next().value);
  }

  function freshModel(key) {
    const entry = models.get(key);
    return entry && Date.now() - entry.cachedAt <= REGIONAL_BRIEF_CACHE_MS
      ? entry.weather
      : null;
  }

  async function modelForCell(key, load) {
    const weather = freshModel(key);
    if (weather) return weather;
    return coalesceProxyRequest(modelInFlight, key, async () => {
      const result = await load();
      if (result) {
        models.set(key, { weather: result, cachedAt: Date.now() });
        trim(models);
      }
      return result;
    }).promise;
  }

  async function weatherForPoint(point, key) {
    // Model cells may be shared. Neither coverage nor a station choice may be.
    if (!isSmnCoveragePoint(point) && freshModel(key)) return freshModel(key);
    try {
      const weather = await weatherProvider(point, (load) =>
        modelForCell(key, load),
      );
      if (weather && weather.source !== 'smn' && !freshModel(key)) {
        models.set(key, { weather, cachedAt: Date.now() });
        trim(models);
      }
      return weather;
    } catch {
      return null;
    }
  }

  async function dmhForPoint(point) {
    if (!isDmhCoveragePoint(point)) return currentDmh(null, point);
    try {
      return currentDmh(await dmhProvider(point), point);
    } catch {
      return { status: 'unavailable', observation: null };
    }
  }

  async function refresh(point, key) {
    const [placeResult, weather, dmh] = await Promise.all([
      Promise.resolve()
        .then(() => placeProvider(point))
        .catch(() => null),
      weatherForPoint(point, key),
      dmhForPoint(point),
    ]);
    const news = (await Promise.resolve()
      .then(() => newsProvider(placeResult))
      .catch(() => null)) || { status: 'unavailable', articles: [] };
    // Only shared regional data and a model enter the cell cache. The seed
    // observations live solely on this in-flight result, never on the cache.
    const payload = {
      retrievedAt: new Date().toISOString(),
      place: placeResult,
      placeStatus: placeResult ? 'ready' : 'unavailable',
      weather: weather?.source === 'smn' ? null : weather,
      newsStatus: news.status,
      newsQuery: news.query,
      newsSource: news.source,
      articles: news.articles,
    };
    return { entry: { payload, cachedAt: Date.now() }, point, weather, dmh };
  }

  async function atPoint(entry, point, key, seed) {
    const samePoint =
      seed &&
      seed.point.latitude === point.latitude &&
      seed.point.longitude === point.longitude;
    let [weather, dmh] = samePoint
      ? [seed.weather, seed.dmh]
      : await Promise.all([weatherForPoint(point, key), dmhForPoint(point)]);
    // Slow news or another source can outlive an observation's own clock.
    if (weather?.source === 'smn') {
      const current =
        isSmnCoveragePoint(point) && smnWeatherAtPoint(weather, point);
      weather = current || (await weatherForPoint(point, key));
      if (weather?.source === 'smn')
        weather = isSmnCoveragePoint(point)
          ? smnWeatherAtPoint(weather, point)
          : null;
    }
    dmh = currentDmh(dmh, point);
    return {
      ...entry.payload,
      coordinates: point,
      weather,
      weatherStatus: weather ? 'ready' : 'unavailable',
      stationObservation: dmh.observation,
      stationObservationStatus: dmh.status,
    };
  }

  function hasSource(payload) {
    return regionalBriefHasAnySource({
      ...payload,
      news: { status: payload.newsStatus },
    });
  }

  function install(middlewares) {
    middlewares.use('/api/regional-brief', async (req, res) => {
      const send = (status, payload, cacheStatus) => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          // Every response must run exact-point selection and source expiry.
          'Cache-Control': 'no-store',
          ...(cacheStatus ? { 'X-Regional-Brief': cacheStatus } : {}),
          ...(status === 429 ? { 'Retry-After': '10' } : {}),
        });
        res.end(JSON.stringify(payload));
      };
      if (req.method !== 'GET')
        return send(405, { error: 'Method Not Allowed' });
      if (!rateLimiter(clientKey(req)))
        return send(429, { error: 'Rate limit exceeded' });
      const point = validRegionalPoint(
        new URL(req.url || '', 'http://localhost').searchParams,
      );
      if (!point)
        return send(400, {
          error: 'Valid latitude and longitude are required',
        });
      const key = `${(Math.round(point.latitude * 10) / 10).toFixed(1)},${(Math.round(point.longitude * 10) / 10).toFixed(1)}`;
      const cached = cache.get(key);
      if (cached && Date.now() - cached.cachedAt <= REGIONAL_BRIEF_CACHE_MS) {
        const payload = await atPoint(cached, point, key);
        return send(200, { ...payload, status: 'cached' }, 'HIT');
      }
      const request = coalesceProxyRequest(inFlight, key, () =>
        refresh(point, key),
      );
      const seed = await request.promise;
      const payload = await atPoint(seed.entry, point, key, seed);
      // A seed outside a source's prefilter must not suppress an in-flight
      // request on the other side of that boundary in the same rounded cell.
      if (hasSource(payload)) {
        cache.set(key, seed.entry);
        trim(cache);
        return send(
          200,
          {
            ...payload,
            status:
              payload.place &&
              payload.weather &&
              payload.newsStatus !== 'unavailable'
                ? 'ready'
                : 'partial',
          },
          request.shared ? 'INFLIGHT' : 'MISS',
        );
      }
      if (cached && Date.now() - cached.cachedAt <= REGIONAL_BRIEF_STALE_MS) {
        // Station fields are absent from the cache and cannot be resurrected.
        const model = models.get(key);
        const weather =
          payload.weather ||
          (model && Date.now() - model.cachedAt <= REGIONAL_BRIEF_STALE_MS
            ? model.weather
            : cached.payload.weather);
        return send(
          200,
          {
            ...cached.payload,
            ...payload,
            place: cached.payload.place,
            placeStatus: cached.payload.placeStatus,
            newsStatus: cached.payload.newsStatus,
            newsQuery: cached.payload.newsQuery,
            newsSource: cached.payload.newsSource,
            articles: cached.payload.articles,
            retrievedAt: cached.payload.retrievedAt,
            weather,
            weatherStatus: weather ? 'ready' : 'unavailable',
            status: 'stale',
          },
          'STALE',
        );
      }
      return send(503, {
        error: 'Regional briefing is temporarily unavailable',
      });
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
