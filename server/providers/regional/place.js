import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { fetchRegionalJson } from './http.js';
import { normalizeRegionalPlace } from '../../../src/data/regionalBrief.js';
import {
  nominatimToGeocodeResult,
  nominatimViewboxFromBounds,
} from '../../../src/nominatimGeocode.js';

const NOMINATIM_HEADERS = Object.freeze({
  'User-Agent':
    'GodsEyeView/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)',
  Referer: 'https://github.com/bilawalsidhu/gods-eye-view',
});

const NOMINATIM_SEARCH_MAX_QUERY = 200;

const NOMINATIM_SEARCH_CACHE_MS = 2 * 60_000;

const NOMINATIM_SEARCH_MAX_CACHE = 80;

let _nominatimQueue = Promise.resolve();

let _nominatimLastRequestAt = 0;

const _nominatimSearchCache = new Map();

const _nominatimSearchRateLimiter = makeRateLimiter({
  windowMs: 60_000,
  max: 30,
  globalMax: 90,
});

function enqueueNominatim(work) {
  const task = _nominatimQueue.then(async () => {
    const waitMs = Math.max(0, 1100 - (Date.now() - _nominatimLastRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    _nominatimLastRequestAt = Date.now();
    return work();
  });
  _nominatimQueue = task.catch(() => null);
  return task;
}

function trimNominatimSearchCache() {
  while (_nominatimSearchCache.size > NOMINATIM_SEARCH_MAX_CACHE) {
    const oldest = _nominatimSearchCache.keys().next().value;
    if (oldest === undefined) break;
    _nominatimSearchCache.delete(oldest);
  }
}

function fetchRegionalPlace(point) {
  return enqueueNominatim(async () => {
    const params = new URLSearchParams({
      format: 'jsonv2',
      lat: point.latitude.toFixed(5),
      lon: point.longitude.toFixed(5),
      zoom: '10',
      addressdetails: '1',
      'accept-language': 'en',
    });
    const payload = await fetchRegionalJson(
      `https://nominatim.openstreetmap.org/reverse?${params}`,
      { headers: NOMINATIM_HEADERS },
    );
    return normalizeRegionalPlace(payload);
  });
}

async function fetchNominatimSearch(query, bounds) {
  const cacheKey = `${query.toLowerCase()}|${bounds || ''}`;
  const cached = _nominatimSearchCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt <= NOMINATIM_SEARCH_CACHE_MS) {
    return { ...cached.payload, cached: true };
  }
  const params = new URLSearchParams({
    format: 'jsonv2',
    q: query,
    addressdetails: '1',
    limit: '1',
    'accept-language': 'en',
  });
  const viewbox = nominatimViewboxFromBounds(bounds);
  if (viewbox) params.set('viewbox', viewbox);
  const rows = await enqueueNominatim(() =>
    fetchRegionalJson(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: NOMINATIM_HEADERS,
    }),
  );
  const result = nominatimToGeocodeResult(Array.isArray(rows) ? rows[0] : null);
  const payload = result
    ? { status: 'OK', results: [result] }
    : { status: 'ZERO_RESULTS', results: [] };
  _nominatimSearchCache.set(cacheKey, { payload, cachedAt: Date.now() });
  trimNominatimSearchCache();
  return payload;
}

function geocodeProxy() {
  function install(middlewares) {
    middlewares.use('/api/geocode', async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }
      if (!_nominatimSearchRateLimiter(clientKey(req))) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '10',
        });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return;
      }
      const url = new URL(req.url || '', 'http://localhost');
      const query = String(url.searchParams.get('q') || '').trim();
      if (!query || query.length > NOMINATIM_SEARCH_MAX_QUERY) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'A place query of 1–200 characters is required',
          }),
        );
        return;
      }
      try {
        const payload = await fetchNominatimSearch(
          query,
          url.searchParams.get('bounds'),
        );
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': payload.cached ? 'public, max-age=60' : 'no-store',
        });
        res.end(
          JSON.stringify({ status: payload.status, results: payload.results }),
        );
      } catch {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({ error: 'Place search is temporarily unavailable' }),
        );
      }
    });
  }

  return {
    name: 'geocode-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { fetchRegionalPlace, fetchNominatimSearch, geocodeProxy };
