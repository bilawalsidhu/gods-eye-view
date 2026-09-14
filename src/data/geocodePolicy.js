/**
 * geocodePolicy.js — the shared keyless geocoder (worker-safe).
 *
 * Location search used to hard-throw on keyless installs: the Google Geocoding
 * API needs a browser key, and the offline Natural Earth pack only covers major
 * natural regions (PLAN.md issues #211/#213, PR #166). This module implements
 * the missing tier — an OpenStreetMap Nominatim search proxied same-origin —
 * as ONE request-resolution core imported by BOTH runtimes (the dev middleware
 * in `vite/proxies/geocode.js` and the Pages Function in
 * `functions/api/geocode.js`), so dev and prod cannot drift.
 *
 * Worker-safe on purpose: web primitives only (URL/URLSearchParams, fetch,
 * Map, Date.now) — no node:*, fs, Buffer, or process — so the same file runs
 * under Connect middleware and workerd.
 *
 * Nominatim usage policy (https://operations.osmfoundation.org/policies/nominatim/):
 * requests must carry an identifying User-Agent, results are attributed to
 * OpenStreetMap, and the public instance asks for at most 1 request/second.
 * The 60 s result cache + single-flight coalescing below keep a session's
 * repeated searches (and a misbehaving client) well inside that budget; a
 * self-hosted instance can be substituted entirely via NOMINATIM_BASE_URL.
 */

/** Default upstream — the public Nominatim instance (keyless). */
export const NOMINATIM_SEARCH_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Identifying User-Agent required by the Nominatim usage policy. */
export const NOMINATIM_USER_AGENT = 'gods-eye-view/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** The client's `q` is trimmed and must land inside this length (openzenith's clamp). */
export const GEOCODE_QUERY_MAX_CHARS = 200;
/** Default and maximum `limit` — 10 is also Nominatim's own max for /search. */
export const GEOCODE_RESULT_LIMIT_DEFAULT = 5;
export const GEOCODE_RESULT_LIMIT_MAX = 10;
/** Result cache TTL — geocodes are stable; 60 s keeps repeat searches upstream-free. */
export const GEOCODE_CACHE_TTL_MS = 60_000;
/** LRU-ish ceiling on cached queries per isolate (evict-oldest on overflow). */
export const GEOCODE_CACHE_MAX_ENTRIES = 256;

/**
 * Parse + validate the request's query parameters.
 *
 * `viewbox` uses the SAME client format as the keyed path's Google `bounds`
 * bias (annotationResolver's viewportBias): "swLat,swLng|neLat,neLng". A
 * malformed or out-of-range viewbox is DROPPED, not rejected — it is a ranking
 * bias, so degrading to an unbiased search can only reorder results, never
 * wrong-answer them. `q` and `limit` are hard contract: invalid values are a
 * 400, because silently defaulting a query the caller believes it sent is how
 * "why does this city not resolve" bugs are born.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{query: string, limit: number, viewbox: {south:number, west:number, north:number, east:number}|null}|null}
 *   null when `q` or `limit` is missing/invalid.
 */
export function parseGeocodeQuery(searchParams) {
  const query = String(searchParams.get('q') ?? '').trim();
  if (!query || query.length > GEOCODE_QUERY_MAX_CHARS) return null;

  const rawLimit = String(searchParams.get('limit') ?? '').trim();
  let limit = GEOCODE_RESULT_LIMIT_DEFAULT;
  if (rawLimit) {
    if (!/^\d+$/.test(rawLimit)) return null;
    limit = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > GEOCODE_RESULT_LIMIT_MAX) return null;
  }

  return { query, limit, viewbox: parseGeocodeViewbox(searchParams.get('viewbox')) };
}

/**
 * Parse the client's `swLat,swLng|neLat,neLng` viewbox into bounded degrees,
 * or null when anything is off (missing, malformed, off-planet).
 * @param {string|null} raw
 */
export function parseGeocodeViewbox(raw) {
  if (!raw) return null;
  const parts = String(raw).split(/[|,]/).map((v) => Number.parseFloat(v));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [swLat, swLng, neLat, neLng] = parts;
  const latOk = (v) => v >= -90 && v <= 90;
  const lonOk = (v) => v >= -180 && v <= 180;
  if (!latOk(swLat) || !latOk(neLat) || !lonOk(swLng) || !lonOk(neLng)) return null;
  // Normalize corner order so the upstream always gets west<east, south<north.
  return {
    south: Math.min(swLat, neLat),
    west: Math.min(swLng, neLng),
    north: Math.max(swLat, neLat),
    east: Math.max(swLng, neLng),
  };
}

/**
 * Build the upstream Nominatim /search URL from a parsed request.
 *
 * `format=jsonv2` (stable `category`/`type` fields, `display_name`), no
 * addressdetails (the client frames, it never renders addresses). `viewbox`
 * is converted from the client's lat-first corner format to Nominatim's
 * lon-first `x1,y1,x2,y2`, WITHOUT `bounded=1` — a bias like the keyed path's
 * Google `bounds`, so an off-screen exact match still wins over an on-screen
 * near-match.
 *
 * @param {{query: string, limit?: number, viewbox?: object|null}} parsed from parseGeocodeQuery
 * @param {string} [baseUrl] upstream /search endpoint (NOMINATIM_BASE_URL override)
 * @returns {URL}
 */
export function buildNominatimSearchUrl(parsed, baseUrl = NOMINATIM_SEARCH_ENDPOINT) {
  const url = new URL(baseUrl);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '0');
  url.searchParams.set('limit', String(Math.min(parsed.limit ?? GEOCODE_RESULT_LIMIT_DEFAULT, GEOCODE_RESULT_LIMIT_MAX)));
  url.searchParams.set('q', parsed.query);
  if (parsed.viewbox) {
    const { south, west, north, east } = parsed.viewbox;
    url.searchParams.set('viewbox', `${west},${south},${east},${north}`);
    url.searchParams.set('bounded', '0');
  }
  return url;
}

/** Upstream request headers — the identifying UA is policy, Accept is manners. */
export function nominatimRequestHeaders() {
  return {
    'User-Agent': NOMINATIM_USER_AGENT,
    Accept: 'application/json',
  };
}

/**
 * Normalize a Nominatim jsonv2 array into the client's result shape.
 *
 * Rows without a parseable lat/lon or a display_name are dropped rather than
 * clamped — a geocoder row that cannot say where it is must not become a
 * flight. `viewport` mirrors the Google-geocode bounds shape
 * (`{southwest:{lat,lng}, northeast:{lat,lng}}`) that `flyToViewportBounds`
 * consumes, converted from Nominatim's `[south, north, west, east]` strings,
 * so the caller frames areas and points with one code path.
 *
 * @param {unknown} payload parsed upstream JSON
 * @returns {{label: string, lat: number, lon: number, kind: string, viewport: object|null}[]}
 */
export function normalizeNominatimResults(payload) {
  if (!Array.isArray(payload)) return [];
  const results = [];
  for (const row of payload) {
    const lat = Number.parseFloat(row?.lat);
    const lon = Number.parseFloat(row?.lon);
    const label = typeof row?.display_name === 'string' ? row.display_name.trim() : '';
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !label) continue;
    const category = typeof row?.category === 'string' ? row.category : '';
    const type = typeof row?.type === 'string' ? row.type : '';
    results.push({
      label,
      lat,
      lon,
      kind: [category, type].filter(Boolean).join(':'),
      viewport: nominatimBoundingBoxToViewport(row?.boundingbox),
    });
  }
  return results;
}

/**
 * Nominatim `boundingbox` ([south, north, west, east] as strings) → the
 * geocode bounds shape, or null when any edge is missing/unparseable.
 * @param {unknown} boundingbox
 */
export function nominatimBoundingBoxToViewport(boundingbox) {
  if (!Array.isArray(boundingbox) || boundingbox.length !== 4) return null;
  const [south, north, west, east] = boundingbox.map((v) => Number.parseFloat(v));
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return {
    southwest: { lat: Math.min(south, north), lng: Math.min(west, east) },
    northeast: { lat: Math.max(south, north), lng: Math.max(west, east) },
  };
}

/** Response envelope the client reads: results + the OSM attribution (policy). */
function successPayload(results) {
  return { results, attribution: '© OpenStreetMap contributors' };
}

/**
 * Resolve one /api/geocode request — the ENTIRE contract, shared verbatim by
 * the dev middleware and the Pages Function. Dependencies are injected so
 * tests run with no network, clock, or server.
 *
 * Contract (both runtimes):
 *   non-GET           → 405 {"error":"Method Not Allowed"}, no-store
 *   bad `q`/`limit`   → 400 {"error":"Missing or invalid q parameter"}, no-store
 *   cache hit (60 s)  → 200 results, X-GEV-Cache: HIT, public max-age=60
 *   refreshed         → 200 results, X-GEV-Cache: MISS (this request went
 *                       upstream) or INFLIGHT (joined a concurrent refresh);
 *                       an upstream 200 with zero usable rows is a SUCCESS
 *                       with `results: []` — a legit no-match, not a failure
 *   upstream non-OK / malformed → 502 {"error":"Geocoder unavailable"}, no-store
 *   refresh failure with a stale entry → 200 stale results,
 *                       X-GEV-Cache: STALE-ERROR, no-store
 *
 * @param {object} deps
 * @param {string} [deps.method] request method (default GET)
 * @param {URLSearchParams} deps.searchParams request query
 * @param {Map<string,{at:number,payload:object}>} deps.cache per-isolate result cache
 * @param {Map<string,Promise<object>>} deps.inFlight single-flight refresh map
 * @param {() => number} [deps.now] clock (Date.now in production)
 * @param {typeof fetch} [deps.fetchImpl] upstream fetch
 * @param {string} [deps.baseUrl] upstream /search endpoint override
 * @param {number} [deps.timeoutMs] upstream abort budget (default 10 s)
 * @returns {Promise<{status: number, payload: object, cacheState: 'MISS'|'HIT'|'INFLIGHT'|'STALE-ERROR'|'NONE', cacheControl: 'public, max-age=60'|'no-store'}>}
 */
export async function resolveGeocodeRequest({
  method = 'GET',
  searchParams,
  cache,
  inFlight,
  now = () => Date.now(),
  fetchImpl = fetch,
  baseUrl = NOMINATIM_SEARCH_ENDPOINT,
  timeoutMs = 10_000,
}) {
  if (method !== 'GET') {
    return fail(405, { error: 'Method Not Allowed' }, 'NONE');
  }
  const parsed = parseGeocodeQuery(searchParams);
  if (!parsed) {
    return fail(400, { error: 'Missing or invalid q parameter' }, 'NONE');
  }

  const key = JSON.stringify([parsed.query, parsed.limit, parsed.viewbox]);
  const at = now();
  const cached = cache.get(key);
  if (cached && at - cached.at < GEOCODE_CACHE_TTL_MS) {
    return ok(cached.payload, 'HIT');
  }

  const pending = inFlight.get(key);
  if (pending) {
    try {
      return ok(await pending, 'INFLIGHT');
    } catch {
      return fail(502, { error: 'Geocoder unavailable' }, 'NONE');
    }
  }

  const refresh = (async () => {
    const url = buildNominatimSearchUrl(parsed, baseUrl);
    const response = await fetchImpl(url, {
      headers: nominatimRequestHeaders(),
      signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
    const payload = successPayload(normalizeNominatimResults(await response.json()));
    cache.set(key, { at: now(), payload });
    while (cache.size > GEOCODE_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    return payload;
  })();
  inFlight.set(key, refresh);
  try {
    return ok(await refresh, 'MISS');
  } catch {
    if (cached) {
      // The earlier error path (this request's own refresh threw) — the stale
      // entry answers instead of a 502, matching the other GEV proxies.
      return { status: 200, payload: cached.payload, cacheState: 'STALE-ERROR', cacheControl: 'no-store' };
    }
    return fail(502, { error: 'Geocoder unavailable' }, 'NONE');
  } finally {
    if (inFlight.get(key) === refresh) inFlight.delete(key);
  }
}

function ok(payload, cacheState) {
  return { status: 200, payload, cacheState, cacheControl: 'public, max-age=60' };
}

function fail(status, payload, cacheState) {
  return { status, payload, cacheState, cacheControl: 'no-store' };
}
