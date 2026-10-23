import { readResponseTextCapped } from './common/http.js';

export const OVATION_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
export const AURORA_CACHE_TTL_MS = 5 * 60_000;
export const AURORA_STALE_MAX_MS = 30 * 60_000;
const MAX_BODY_BYTES = 1_500_000;

function validUtc(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
  )
    return false;
  const normalized =
    value.endsWith('Z') && !value.includes('.')
      ? value.replace(/Z$/, '.000Z')
      : value;
  return new Date(value).toISOString() === normalized;
}

/** Validate and normalize NOAA's 360×181 global OVATION probability grid. */
export function normalizeOvation(payload) {
  const coordinates = payload?.coordinates;
  const forecastTime = payload?.['Forecast Time'];
  const observationTime = payload?.['Observation Time'];
  if (
    !validUtc(forecastTime) ||
    !validUtc(observationTime) ||
    !Array.isArray(coordinates) ||
    coordinates.length !== 360 * 181
  )
    throw new Error('Invalid OVATION forecast');
  const values = new Array(360 * 181);
  const seen = new Uint8Array(values.length);
  for (const point of coordinates) {
    if (!Array.isArray(point) || point.length < 3)
      throw new Error('Invalid OVATION forecast');
    const [lon, lat, probability] = point;
    if (
      !Number.isInteger(lon) ||
      lon < 0 ||
      lon > 359 ||
      !Number.isInteger(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 100
    )
      throw new Error('Invalid OVATION forecast');
    const index = (lat + 90) * 360 + lon;
    if (seen[index]) throw new Error('Invalid OVATION forecast');
    seen[index] = 1;
    values[index] = probability;
  }
  if (seen.includes(0)) throw new Error('Invalid OVATION forecast');
  return {
    schemaVersion: 1,
    product: 'ovation-aurora',
    coordinateOrder: ['longitude', 'latitude', 'probability'],
    forecastTime: new Date(forecastTime).toISOString(),
    observationTime: new Date(observationTime).toISOString(),
    horizonMinutes: {
      min: 30,
      max: 90,
      variable: true,
    },
    grid: { nx: 360, ny: 181, lo1: 0, la1: -90, dx: 1, dy: 1 },
    probabilities: values,
    stale: false,
    unavailable: false,
  };
}

/** Shared, bounded NOAA fetch: CORS allows direct use, but caching avoids one
 * ~925 KB upstream request per browser tab every generation. */
export function auroraProxy({
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = AURORA_CACHE_TTL_MS,
  staleMaxMs = AURORA_STALE_MAX_MS,
  timeoutMs = 15000,
} = {}) {
  let cache = null;
  let loading = null;
  let lastFailureAt = -Infinity;

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(OVATION_URL, {
          signal: controller.signal,
          redirect: 'error',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`OVATION HTTP ${response.status}`);
        const contentType = response.headers?.get?.('content-type') || '';
        if (!contentType.toLowerCase().startsWith('application/json'))
          throw new Error('Invalid OVATION content type');
        const raw = await readResponseTextCapped(response, MAX_BODY_BYTES);
        controller.signal.throwIfAborted();
        const value = normalizeOvation(JSON.parse(raw));
        cache = { value, fetchedAt: now() };
        lastFailureAt = -Infinity;
        return value;
      } catch (error) {
        lastFailureAt = now();
        throw error;
      } finally {
        clearTimeout(timer);
        loading = null;
      }
    })();
    return loading;
  }

  const handler = async (req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    if (
      method !== 'GET' ||
      !['', '/', '/forecast'].includes(req.url?.split('?')[0] || '')
    ) {
      res.writeHead(method === 'GET' ? 404 : 405, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify({
          error: method === 'GET' ? 'Not Found' : 'Method Not Allowed',
        }),
      );
      return;
    }
    try {
      const cacheAge = cache ? now() - cache.fetchedAt : Infinity;
      const fresh = Boolean(cache) && cacheAge < ttlMs;
      const retryCooling =
        Boolean(cache) &&
        cacheAge >= ttlMs &&
        cacheAge <= staleMaxMs &&
        now() - lastFailureAt < ttlMs;
      const unavailableCooling = !cache && now() - lastFailureAt < ttlMs;
      const value =
        fresh || retryCooling
          ? cache.value
          : unavailableCooling
            ? null
            : await load();
      if (!value) throw new Error('OVATION refresh backoff');
      const stale = retryCooling;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(stale ? { ...value, stale: true } : value));
    } catch {
      const age = cache ? now() - cache.fetchedAt : Infinity;
      const value =
        age <= staleMaxMs
          ? { ...cache.value, stale: true }
          : {
              schemaVersion: 1,
              product: 'ovation-aurora',
              unavailable: true,
              stale: true,
              reason: 'NOAA SWPC OVATION forecast unavailable',
            };
      res.writeHead(value.unavailable ? 503 : 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    }
  };
  return {
    name: 'aurora',
    configureServer({ middlewares }) {
      middlewares.use('/api/aurora', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/aurora', handler);
    },
  };
}
