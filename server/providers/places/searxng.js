import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { readCappedResponseText } from '../common/http.js';
import { haversineKm } from '../common/geo.js';
import {
  nominatimLatitude,
  nominatimLongitude,
  nominatimToGeocodeResult,
} from '../../../src/nominatimGeocode.js';

const SEARXNG_TIMEOUT_MS = 8_000;
const SEARXNG_MAX_BYTES = 1_000_000;
const SEARXNG_MAX_QUERY = 200;
const SEARXNG_CACHE_MS = 5 * 60_000;
const SEARXNG_MAX_CACHE = 100;

/**
 * The operator's SearXNG base URL, or null. A pasted /search or /preferences
 * page URL is accepted; only the instance root is kept.
 */
export function searxngBaseUrl(env = process.env) {
  const raw = String(env.SEARXNG_URL || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return null;
  const path = url.pathname
    .replace(/\/(search|preferences)\/?$/, '')
    .replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Parse Google-style `south,west|north,east` bounds, or null. */
function parseBounds(bounds) {
  const match = String(bounds || '')
    .trim()
    .match(/^([^,|]+),([^,|]+)\|([^,|]+),([^,|]+)$/);
  if (!match) return null;
  const south = nominatimLatitude(match[1]);
  const west = nominatimLongitude(match[2]);
  const north = nominatimLatitude(match[3]);
  const east = nominatimLongitude(match[4]);
  if ([south, west, north, east].some((value) => value === null)) return null;
  return south < north ? { south, west, north, east } : null;
}

function insideBounds(hit, box) {
  if (hit.lat < box.south || hit.lat > box.north) return false;
  return box.west <= box.east
    ? hit.lon >= box.west && hit.lon <= box.east
    : hit.lon >= box.west || hit.lon <= box.east;
}

/** Normalize one SearXNG map result into a Nominatim-shaped hit, or null. */
export function normalizeSearxngHit(result) {
  const lat = nominatimLatitude(result?.latitude);
  const lon = nominatimLongitude(result?.longitude);
  const name = String(result?.title || '').trim();
  if (lat === null || lon === null || !name) return null;
  const address =
    result.address && typeof result.address === 'object' ? result.address : {};
  const street = [address.road, address.house_number].filter(Boolean).join(' ');
  const parts = [name, street, address.locality, address.country]
    .map((part) => String(part || '').trim())
    .filter((part, index, all) => part && all.indexOf(part) === index);
  return {
    lat,
    lon,
    name,
    display_name: parts.join(', ').slice(0, 240),
    boundingbox: Array.isArray(result.boundingbox) ? result.boundingbox : null,
  };
}

/** Construct a bounded SearXNG map-search client for one server lifetime. */
export function createSearxngSearch({
  resolveBaseUrl = () => searxngBaseUrl(),
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
} = {}) {
  const cache = new Map();
  return async function search(query, { signal } = {}) {
    const base = resolveBaseUrl();
    if (!base) return null;
    const key = `${base}\n${query.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < SEARXNG_CACHE_MS) return cached.hits;
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      categories: 'map',
    });
    const response = await fetchImpl(`${base}/search?${params}`, {
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any(
        [signal, AbortSignal.timeout(SEARXNG_TIMEOUT_MS)].filter(Boolean),
      ),
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`SearXNG answered HTTP ${response.status}`);
    }
    const { tooLarge, text } = await readCappedResponseText(
      response,
      SEARXNG_MAX_BYTES,
    );
    if (tooLarge) throw new Error('SearXNG response too large');
    const data = JSON.parse(text);
    const hits = (Array.isArray(data?.results) ? data.results : [])
      .map(normalizeSearxngHit)
      .filter(Boolean)
      .slice(0, 20);
    cache.set(key, { hits, at: now() });
    while (cache.size > SEARXNG_MAX_CACHE)
      cache.delete(cache.keys().next().value);
    return hits;
  };
}

function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

/**
 * Vite plugin: forward geocoding and view-biased text search through the
 * operator's own SearXNG instance (`SEARXNG_URL`). The browser never learns the
 * instance address; an unset URL answers as an unconfigured capability.
 */
export function searxngPlacesProxy({ search = createSearxngSearch() } = {}) {
  const limiter = makeRateLimiter({
    windowMs: 60_000,
    max: 60,
    globalMax: 180,
  });

  async function lookup(req, res, emptyPayload) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ...emptyPayload, error: 'Method not allowed' });
      return null;
    }
    let url = null;
    try {
      url = new URL(req.url || '', 'http://localhost');
    } catch {
      /* A path such as `//?q=a` is not a URL; answer it as a bad request. */
    }
    const query = String(url?.searchParams.get('q') || '').trim();
    if (!query || query.length > SEARXNG_MAX_QUERY) {
      sendJson(res, 400, {
        ...emptyPayload,
        error: 'A query of 1-200 characters is required',
      });
      return null;
    }
    if (!limiter(clientKey(req))) {
      sendJson(
        res,
        429,
        { ...emptyPayload, error: 'Rate limit exceeded' },
        { 'Retry-After': '10' },
      );
      return null;
    }
    const abandoned = new AbortController();
    res.on?.('close', () => abandoned.abort());
    try {
      const hits = await search(query, { signal: abandoned.signal });
      if (hits === null) {
        sendJson(res, 200, { ...emptyPayload, configured: false });
        return null;
      }
      return { hits, params: url.searchParams };
    } catch {
      if (!res.writableEnded)
        sendJson(res, 502, {
          ...emptyPayload,
          error: 'SearXNG search is temporarily unavailable',
        });
      return null;
    }
  }

  function install(middlewares) {
    middlewares.use('/api/searxng/geocode', async (req, res) => {
      const found = await lookup(req, res, {
        status: 'ZERO_RESULTS',
        results: [],
      });
      if (!found) return;
      const box = parseBounds(found.params.get('bounds'));
      const hit =
        (box && found.hits.find((candidate) => insideBounds(candidate, box))) ||
        found.hits[0];
      const result = nominatimToGeocodeResult(hit);
      sendJson(
        res,
        200,
        result
          ? { status: 'OK', results: [result] }
          : { status: 'ZERO_RESULTS', results: [] },
        { 'Cache-Control': 'private, max-age=60' },
      );
    });

    middlewares.use('/api/searxng/text-search', async (req, res) => {
      const found = await lookup(req, res, { places: [] });
      if (!found) return;
      const latitude = nominatimLatitude(found.params.get('lat'));
      const longitude = nominatimLongitude(found.params.get('lon'));
      if (latitude === null || longitude === null) {
        sendJson(res, 400, {
          places: [],
          error: 'Valid lat and lon are required',
        });
        return;
      }
      const radiusM = Math.max(
        50,
        Math.min(50_000, Number(found.params.get('radiusM')) || 4000),
      );
      const places = found.hits
        .map((hit) => {
          const geocoded = nominatimToGeocodeResult(hit);
          const viewport = geocoded?.geometry?.viewport;
          return {
            id: null,
            name: hit.name,
            address: hit.display_name,
            latitude: hit.lat,
            longitude: hit.lon,
            distanceM: Math.round(
              haversineKm(latitude, longitude, hit.lat, hit.lon) * 1000,
            ),
            primaryType: null,
            types: geocoded?.types || [],
            viewport: viewport
              ? {
                  low: {
                    latitude: viewport.southwest.lat,
                    longitude: viewport.southwest.lng,
                  },
                  high: {
                    latitude: viewport.northeast.lat,
                    longitude: viewport.northeast.lng,
                  },
                }
              : null,
          };
        })
        .filter((place) => place.distanceM <= radiusM)
        .slice(0, 5);
      sendJson(
        res,
        200,
        { places, error: null },
        { 'Cache-Control': 'private, max-age=300' },
      );
    });
  }

  return {
    name: 'searxng-places-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}
