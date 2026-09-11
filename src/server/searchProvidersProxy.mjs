/**
 * Server-only search providers used by the Vite development server.
 * Foursquare credentials never reach the browser. Nominatim is proxied so GEV can supply the
 * identifying User-Agent required by the public Nominatim usage policy and centrally throttle it.
 */

const DEFAULT_NOMINATIM_ORIGIN = 'https://nominatim.openstreetmap.org';
const FOURSQUARE_ORIGIN = 'https://places-api.foursquare.com';
const FSQ_API_VERSION = '2025-06-17';
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const NOMINATIM_USER_AGENT = 'GodsEyeView-local-search/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

const nominatimCache = new Map();
let lastNominatimAt = 0;
let nominatimQueue = Promise.resolve();

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function cleanQuery(value, max = 256) {
  const text = String(value || '').trim();
  return text && text.length <= max ? text : null;
}

function parseFinite(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function parseBias(value) {
  const text = cleanQuery(value, 160);
  if (!text) return null;
  // Google bounds shape from viewportBias(): "south,west|north,east".
  const match = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\|\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!match) return null;
  const south = parseFinite(match[1], -90, 90);
  const west = parseFinite(match[2], -180, 180);
  const north = parseFinite(match[3], -90, 90);
  const east = parseFinite(match[4], -180, 180);
  return [south, west, north, east].some((value) => value === null)
    ? null
    : { south, west, north, east };
}

async function waitForNominatimTurn() {
  const run = async () => {
    const waitMs = Math.max(0, NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastNominatimAt = Date.now();
  };
  const next = nominatimQueue.then(run, run);
  nominatimQueue = next.catch(() => {});
  return next;
}

async function nominatimSearch(url, fetchImpl, env) {
  const q = cleanQuery(url.searchParams.get('q'));
  if (!q) return { status: 400, body: { error: 'q is required' } };

  const bias = parseBias(url.searchParams.get('bias'));
  const cacheKey = JSON.stringify([q.toLowerCase(), bias]);
  if (nominatimCache.has(cacheKey)) return { status: 200, body: nominatimCache.get(cacheKey) };

  const configuredOrigin = String(env.NOMINATIM_BASE_URL || DEFAULT_NOMINATIM_ORIGIN).trim();
  let nominatimOrigin;
  try {
    nominatimOrigin = new URL(configuredOrigin);
  } catch {
    return { status: 503, body: { error: 'Invalid NOMINATIM_BASE_URL' } };
  }
  if (!['http:', 'https:'].includes(nominatimOrigin.protocol)) {
    return { status: 503, body: { error: 'Invalid NOMINATIM_BASE_URL protocol' } };
  }

  const upstream = new URL('/search', nominatimOrigin);
  upstream.searchParams.set('q', q);
  upstream.searchParams.set('format', 'jsonv2');
  upstream.searchParams.set('addressdetails', '1');
  upstream.searchParams.set('namedetails', '1');
  upstream.searchParams.set('limit', '1');
  if (bias) {
    upstream.searchParams.set('viewbox', `${bias.west},${bias.north},${bias.east},${bias.south}`);
    upstream.searchParams.set('bounded', '0');
  }

  await waitForNominatimTurn();
  const response = await fetchImpl(upstream, {
    headers: {
      Accept: 'application/json',
      'User-Agent': NOMINATIM_USER_AGENT,
    },
  });
  if (!response.ok) return { status: 502, body: { error: 'Nominatim unavailable' } };
  const rows = await response.json();
  const result = Array.isArray(rows) && rows.length ? rows[0] : null;
  const body = { result };
  nominatimCache.set(cacheKey, body);
  if (nominatimCache.size > 250) nominatimCache.delete(nominatimCache.keys().next().value);
  return { status: 200, body };
}

function normaliseFsqPlace(place) {
  const latitude = Number(place?.latitude);
  const longitude = Number(place?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const categories = Array.isArray(place?.categories) ? place.categories : [];
  const categoryNames = categories.map((category) => String(category?.name || '').toLowerCase()).filter(Boolean);
  const types = [];
  if (categoryNames.some((name) => name.includes('park'))) types.push('park');
  if (categoryNames.some((name) => name.includes('airport'))) types.push('airport');
  if (categoryNames.some((name) => name.includes('university') || name.includes('college'))) types.push('university');
  if (categoryNames.some((name) => name.includes('stadium'))) types.push('stadium');
  if (categoryNames.some((name) => name.includes('zoo'))) types.push('zoo');
  if (categoryNames.some((name) => name.includes('hospital') || name.includes('medical center'))) types.push('hospital');
  if (categoryNames.some((name) => name.includes('shopping mall') || name.includes('shopping centre') || name.includes('shopping center'))) types.push('shopping_mall');
  if (categoryNames.some((name) => name.includes('museum') || name.includes('landmark') || name.includes('attraction'))) types.push('tourist_attraction');
  if (!types.length) types.push('establishment');

  return {
    id: place.fsq_place_id || place.fsq_id || null,
    name: place.name || null,
    latitude,
    longitude,
    primaryType: categories[0]?.name || null,
    types,
    viewport: null,
    address: place.address || place.location?.formatted_address || null,
    locality: place.locality || place.location?.locality || null,
    region: place.region || place.location?.region || null,
    provider: 'foursquare',
  };
}

async function foursquareSearch(url, fetchImpl, env) {
  const key = String(env.FOURSQUARE_SERVICE_KEY || '').trim();
  if (!key) return { status: 503, body: { error: 'Foursquare service key not configured', places: [] } };

  const q = cleanQuery(url.searchParams.get('q'));
  const lat = parseFinite(url.searchParams.get('lat'), -90, 90);
  const lon = parseFinite(url.searchParams.get('lon'), -180, 180);
  const radiusRaw = Number(url.searchParams.get('radiusM'));
  const radius = Number.isFinite(radiusRaw) ? Math.max(1, Math.min(100000, Math.round(radiusRaw))) : 6000;
  if (!q || lat === null || lon === null) {
    return { status: 400, body: { error: 'q, lat and lon are required', places: [] } };
  }

  const upstream = new URL('/places/search', FOURSQUARE_ORIGIN);
  upstream.searchParams.set('query', q);
  upstream.searchParams.set('ll', `${lat},${lon}`);
  upstream.searchParams.set('radius', String(radius));
  upstream.searchParams.set('limit', '5');
  upstream.searchParams.set('fields', 'fsq_place_id,name,categories,location,latitude,longitude,distance');

  const response = await fetchImpl(upstream, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      'X-Places-Api-Version': FSQ_API_VERSION,
    },
  });
  if (response.status === 401) return { status: 401, body: { error: 'Foursquare rejected the configured key', places: [] } };
  if (!response.ok) return { status: 502, body: { error: 'Foursquare Places unavailable', places: [] } };
  const data = await response.json();
  const source = Array.isArray(data?.results) ? data.results : Array.isArray(data?.places) ? data.places : [];
  const places = source.map(normaliseFsqPlace).filter(Boolean);
  return { status: 200, body: { places } };
}

export function searchProvidersProxy({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'search-providers-proxy',
    configureServer(server) {
      server.middlewares.use('/api/nominatim/search', async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          const result = await nominatimSearch(url, fetchImpl, env);
          return json(res, result.status, result.body);
        } catch {
          return json(res, 502, { error: 'Nominatim unavailable' });
        }
      });

      server.middlewares.use('/api/foursquare/place-search', async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed', places: [] });
        try {
          const url = new URL(req.url || '/', 'http://localhost');
          const result = await foursquareSearch(url, fetchImpl, env);
          return json(res, result.status, result.body);
        } catch {
          return json(res, 502, { error: 'Foursquare Places unavailable', places: [] });
        }
      });
    },
  };
}

export const _test = Object.freeze({
  foursquareSearch,
  nominatimSearch,
  normaliseFsqPlace,
  parseBias,
});
