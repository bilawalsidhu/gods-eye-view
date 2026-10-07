import path from 'node:path';
import { makeRateLimiter, clientKey } from '../common/rate-limit.js';
import { coalesceProxyRequest } from '../common/http.js';
import { naturalRegionAtPoint } from '../../../src/data/naturalEarthRegions.js';
import {
  nominatimToGeocodeResult,
  nominatimViewboxFromBounds,
} from '../../../src/nominatimGeocode.js';
import {
  NOMINATIM_MAX_PENDING,
  isNominatimBusy,
  sharedNominatimGate,
} from './nominatimGate.js';
import {
  NOMINATIM_CACHE_TTL_MS,
  createNominatimCache,
} from './nominatimCache.js';
import {
  OUTLINE_KINDS,
  OUTLINE_POLYGON_THRESHOLD,
  outlineBias,
  selectOutlineResult,
} from './outlineSelect.js';

const NOMINATIM_SEARCH_MAX_QUERY = 200;

/** Results considered per outline ask: enough to skip a node or a wrong type. */
const OUTLINE_RESULT_LIMIT = 3;

/** Largest upstream answer read for an outline (polygons are simplified upstream). */
const OUTLINE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Bump when the cached payload shape changes, so old entries are never read. */
const CACHE_SCHEMA = 'v2';

/**
 * The query text actually sent upstream: Unicode-composed, whitespace
 * collapsed. Nothing else is changed, so two queries share a cache entry only
 * when they are the same upstream request.
 */
export function upstreamQuery(query) {
  return String(query ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cache key: endpoint, schema and the exact upstream parameters. */
function requestKey(gate, kind, params) {
  const endpoint = gate.settings?.()?.endpoint || 'none';
  return `${CACHE_SCHEMA}|${endpoint}|${kind}|${params}`;
}

function malformed() {
  return Object.assign(new Error('Place answer was not understood'), {
    code: 'NOMINATIM_MALFORMED',
  });
}

/** Where the dev server keeps Nominatim answers and the daily count. */
export const NOMINATIM_CACHE_DIR = path.join(
  process.cwd(),
  '.gev-cache',
  'nominatim',
);

/** Construct the offline regional context provider from bundled Natural Earth polygons. */
export function createRegionalPlaceProvider() {
  return (point) => naturalRegionAtPoint(point.latitude, point.longitude);
}

export const fetchRegionalPlace = createRegionalPlaceProvider();

/**
 * Snap a `"swLat,swLng|neLat,neLng"` view to a coarse grid so small camera
 * moves reuse one cache entry. The viewbox is a soft preference upstream.
 */
function coarseBounds(bounds) {
  const match = String(bounds || '')
    .trim()
    .split('|')
    .map((corner) => corner.split(',').map(Number));
  if (match.length !== 2 || match.some((c) => c.length !== 2)) return null;
  const [[swLat, swLng], [neLat, neLng]] = match;
  if (![swLat, swLng, neLat, neLng].every(Number.isFinite)) return null;
  const span = Math.max(neLat - swLat, neLng - swLng, 0.01);
  const step = 2 ** Math.ceil(Math.log2(span));
  const cLat = Math.round((swLat + neLat) / 2 / (step / 4)) * (step / 4);
  const cLng = Math.round((swLng + neLng) / 2 / (step / 4)) * (step / 4);
  const clamp = (v, limit) => Math.max(-limit, Math.min(limit, v));
  const fix = (v) => Number(v.toFixed(4));
  return `${fix(clamp(cLat - step / 2, 90))},${fix(clamp(cLng - step / 2, 180))}|${fix(clamp(cLat + step / 2, 90))},${fix(clamp(cLng + step / 2, 180))}`;
}

/**
 * Construct the forward search adapter over the shared gate.
 *
 * The policy asks that results be cached, and warns that a client repeating
 * the same query may be treated as faulty, so answers are kept (30 days for a
 * hit, 24 hours for a genuine no-result; a failure is never kept) and
 * identical searches already in flight share one upstream call.
 */
export function createNominatimSearchProvider({
  gate = () => sharedNominatimGate(),
  cache = createNominatimCache(),
} = {}) {
  const inFlight = new Map();
  const currentGate = () => (typeof gate === 'function' ? gate() : gate);

  return async function fetchNominatimSearch(query, bounds, { signal } = {}) {
    const coarse = coarseBounds(bounds);
    const params = new URLSearchParams({
      format: 'jsonv2',
      q: upstreamQuery(query),
      addressdetails: '1',
      limit: '1',
      'accept-language': 'en',
    });
    const viewbox = nominatimViewboxFromBounds(coarse);
    if (viewbox) params.set('viewbox', viewbox);
    const gateNow = currentGate();
    const cacheKey = requestKey(gateNow, 'search', params);
    const cached = await cache.get(cacheKey);
    if (cached) return { ...cached.payload, cached: true };
    const { promise } = coalesceProxyRequest(inFlight, cacheKey, async () => {
      const rows = await gateNow.requestJson(
        (endpoint) => `${endpoint}?${params}`,
        { signal },
      );
      // Only a well-formed empty list is "no such place"; anything else is a
      // failure and is never cached.
      if (!Array.isArray(rows)) throw malformed();
      const result = nominatimToGeocodeResult(rows[0] ?? null);
      if (rows.length && !result) throw malformed();
      const payload = result
        ? { status: 'OK', results: [result] }
        : { status: 'ZERO_RESULTS', results: [] };
      await cache.set(
        cacheKey,
        payload,
        result ? NOMINATIM_CACHE_TTL_MS.place : NOMINATIM_CACHE_TTL_MS.notFound,
      );
      return payload;
    });
    return await promise;
  };
}

/**
 * Construct the outline lookup: one guarded search with polygons for one
 * explicit ask, accepting only a result whose class suits the ask kind.
 * Found outlines are kept 90 days and genuine no-results 24 hours.
 */
export function createNominatimOutlineProvider({
  gate = () => sharedNominatimGate(),
  cache = createNominatimCache(),
} = {}) {
  const inFlight = new Map();
  const currentGate = () => (typeof gate === 'function' ? gate() : gate);

  return async function fetchNominatimOutline(
    { query, kind, lat, lon },
    { signal } = {},
  ) {
    const bias = outlineBias(kind, lat, lon);
    const sent = upstreamQuery(query);
    const params = new URLSearchParams({
      format: 'jsonv2',
      q: sent,
      limit: String(OUTLINE_RESULT_LIMIT),
      polygon_geojson: '1',
      polygon_threshold: String(OUTLINE_POLYGON_THRESHOLD[kind]),
      namedetails: '1',
      'accept-language': 'en',
    });
    if (bias) params.set('viewbox', bias.viewbox);
    const gateNow = currentGate();
    const cacheKey = requestKey(gateNow, `outline-${kind}`, params);
    const cached = await cache.get(cacheKey);
    if (cached) return { ...cached.payload, cached: true };
    const { promise } = coalesceProxyRequest(inFlight, cacheKey, async () => {
      const rows = await gateNow.requestJson(
        (endpoint) => `${endpoint}?${params}`,
        { signal, maxBytes: OUTLINE_MAX_RESPONSE_BYTES },
      );
      if (!Array.isArray(rows)) throw malformed();
      const { outline, skipped } = selectOutlineResult(rows, {
        kind,
        query: sent,
      });
      const payload = outline
        ? { status: 'OK', outline }
        : { status: 'ZERO_RESULTS', outline: null, skipped };
      await cache.set(
        cacheKey,
        payload,
        outline
          ? NOMINATIM_CACHE_TTL_MS.outline
          : NOMINATIM_CACHE_TTL_MS.notFound,
      );
      return payload;
    });
    return await promise;
  };
}

export const fetchNominatimSearch = createNominatimSearchProvider();

/** A browser on another site may not spend this install's allowance. */
function crossSite(req) {
  return (
    String(req.headers?.['sec-fetch-site'] || '').toLowerCase() === 'cross-site'
  );
}

function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

/** Map a gate refusal to the route's answer. Never "not found". */
function sendFailure(res, error, what) {
  if (error?.code === 'NOMINATIM_DISABLED') {
    sendJson(res, 503, {
      error: `${what} is not configured`,
      code: 'NOMINATIM_DISABLED',
      retryable: false,
    });
    return;
  }
  if (error?.code === 'NOMINATIM_DAILY_CAP') {
    sendJson(
      res,
      429,
      {
        error: `${what} daily allowance is used`,
        code: 'NOMINATIM_DAILY_CAP',
        retryable: false,
      },
      { 'Retry-After': '3600' },
    );
    return;
  }
  if (isNominatimBusy(error)) {
    const seconds = Math.max(5, Math.ceil((error.retryAfterMs || 0) / 1000));
    sendJson(
      res,
      429,
      { error: `${what} is busy`, code: error.code },
      { 'Retry-After': String(seconds) },
    );
    return;
  }
  sendJson(res, 503, {
    error: `${what} is temporarily unavailable`,
    code: 'NOMINATIM_UNAVAILABLE',
  });
}

/**
 * Vite plugin: last-resort place search (`/api/geocode`) and voice outlines
 * (`/api/geocode/outline`) over the configured Nominatim endpoint.
 *
 * `storageDir` turns on the disk cache and the persisted daily count; the
 * application composition supplies it, tests and embedders may omit it.
 */
export function geocodeProxy({
  search,
  outline,
  storageDir = null,
  gate = null,
} = {}) {
  const currentGate = () => gate || sharedNominatimGate();
  if (storageDir) {
    // The shared count and pause live beside, never inside, the answer cache,
    // so no cache sweep can reset them.
    currentGate().persistUsage(path.join(storageDir, 'state.json'));
    const diskCache = createNominatimCache({
      dir: path.join(storageDir, 'answers'),
    });
    void diskCache.sweep();
    search ||= createNominatimSearchProvider({
      gate: currentGate,
      cache: diskCache,
    });
    outline ||= createNominatimOutlineProvider({
      gate: currentGate,
      cache: diskCache,
    });
  }
  search ||= gate
    ? createNominatimSearchProvider({ gate })
    : fetchNominatimSearch;
  outline ||= createNominatimOutlineProvider({ gate: currentGate });

  const searchLimiter = makeRateLimiter({
    windowMs: 60_000,
    max: 30,
    globalMax: 90,
  });
  // Outlines are explicit voice asks: a person cannot make many a minute.
  const outlineLimiter = makeRateLimiter({
    windowMs: 60_000,
    max: 12,
    globalMax: 30,
  });

  /** Common front door: method, same-site, rate limit, abandonment signal. */
  function admit(req, res, limiter) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return null;
    }
    if (crossSite(req)) {
      sendJson(res, 403, { error: 'Cross-site requests are not accepted' });
      return null;
    }
    if (!limiter(clientKey(req))) {
      sendJson(
        res,
        429,
        { error: 'Rate limit exceeded' },
        { 'Retry-After': '10' },
      );
      return null;
    }
    // A browser that gave up is no longer waiting; the queue reads this
    // before spending its slot.
    const abandoned = new AbortController();
    req.on?.('aborted', () => abandoned.abort());
    res.on?.('close', () => abandoned.abort());
    return abandoned.signal;
  }

  async function handleOutline(req, res, url) {
    const signal = admit(req, res, outlineLimiter);
    if (!signal) return;
    const query = String(url.searchParams.get('q') || '').trim();
    const kind = String(url.searchParams.get('kind') || '');
    if (
      !query ||
      query.length > NOMINATIM_SEARCH_MAX_QUERY ||
      !OUTLINE_KINDS.includes(kind)
    ) {
      sendJson(res, 400, {
        error:
          'A place query of 1-200 characters and a known kind are required',
      });
      return;
    }
    try {
      const payload = await outline(
        {
          query,
          kind,
          lat: url.searchParams.get('lat'),
          lon: url.searchParams.get('lon'),
        },
        { signal },
      );
      sendJson(
        res,
        200,
        { status: payload.status, outline: payload.outline || null },
        {
          'Cache-Control': payload.cached ? 'private, max-age=300' : 'no-store',
        },
      );
    } catch (error) {
      sendFailure(res, error, 'Outline lookup');
    }
  }

  async function handleSearch(req, res, url) {
    const signal = admit(req, res, searchLimiter);
    if (!signal) return;
    const query = String(url.searchParams.get('q') || '').trim();
    if (!query || query.length > NOMINATIM_SEARCH_MAX_QUERY) {
      sendJson(res, 400, {
        error: 'A place query of 1-200 characters is required',
      });
      return;
    }
    try {
      const payload = await search(query, url.searchParams.get('bounds'), {
        signal,
      });
      sendJson(
        res,
        200,
        { status: payload.status, results: payload.results },
        { 'Cache-Control': payload.cached ? 'public, max-age=60' : 'no-store' },
      );
    } catch (error) {
      sendFailure(res, error, 'Place search');
    }
  }

  function install(middlewares) {
    middlewares.use('/api/geocode', async (req, res, next) => {
      const url = new URL(req.url || '', 'http://localhost');
      if (url.pathname === '/outline') return handleOutline(req, res, url);
      if (url.pathname === '/' || url.pathname === '')
        return handleSearch(req, res, url);
      if (typeof next === 'function') return next();
      sendJson(res, 404, { error: 'Not Found' });
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

export { NOMINATIM_MAX_PENDING };
