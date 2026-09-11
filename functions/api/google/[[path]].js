// functions/api/google/[[path]].js
/**
 * `/api/google/nearby-places` + `/api/google/text-search` — Cloudflare Pages
 * Function (catch-all).
 *
 * Production counterpart of the dev `googlePlacesContextProxy` middlewares in
 * `vite.config.js`. These endpoints power the HUD's scene-context enrichment:
 * Nearby Search lists named places around the screen-space target (the 3D
 * Tiles mesh exposes no map-label metadata), Text Search resolves a named
 * landmark to its actual coordinate, biased to the view. Lives at a catch-all
 * because the client only ever calls these SUBPATHS, and Pages routes a
 * static function file at its exact path only.
 *
 * Both runtimes share ONE policy module (`src/data/googlePlacesPolicy.js`):
 * field masks, request builders, and response normalization — so dev and
 * production return identical payloads.
 *
 * Contract (identical to dev):
 *   GET 200 { places, error: null } with `Cache-Control: private, max-age=300`
 *   non-GET          → 405 { error: 'Method not allowed', places: [] }
 *   cross-site GET   → 403 { error: 'cross-origin requests are rejected', places: [] }
 *   over rate limit  → 429 { error: 'Rate limit exceeded', places: [] } + Retry-After: 5
 *   missing key      → 503 { error: 'GOOGLE_MAPS_API_KEY is not set', places: [] }
 *   bad params       → 400 { error, places: [] }
 *   upstream status verbatim (with { places, error: upstream message })
 *   fetch failure    → 502 { error, places: [] }
 *
 * Same-site: GETs carry no `Origin`, so the guard reads `Sec-Fetch-Site`
 * (attached by every modern browser); anything but same-origin/none is a
 * cross-site drive-by burning this deployment's Google quota and is
 * rejected. Absent headers = non-browser client — allowed, throttled.
 *
 * Rate limiting: default-ON on Pages (60/min/IP via
 * `PAGES_RATELIMIT_GOOGLE_PER_MIN`); `GEV_RATELIMIT_GOOGLE_PER_MIN`
 * overrides, `0` disables. Dev's middleware stays opt-in (unset = open) —
 * the dev server is localhost-bound by default.
 *
 * The key never appears in a response, a header the client reads, or an
 * error message.
 */
import {
  GOOGLE_NEARBY_FIELD_MASK,
  GOOGLE_NEARBY_RADIUS_DEFAULT_M,
  GOOGLE_NEARBY_RADIUS_MAX_M,
  GOOGLE_NEARBY_RADIUS_MIN_M,
  GOOGLE_TEXT_FIELD_MASK,
  GOOGLE_TEXT_RADIUS_DEFAULT_M,
  GOOGLE_TEXT_RADIUS_MAX_M,
  GOOGLE_TEXT_RADIUS_MIN_M,
  buildNearbyRequestBody,
  buildTextSearchRequestBody,
  normalizeNearbyPlaces,
  normalizeTextPlaces,
  parseCoordinateParam,
} from '../../../src/data/googlePlacesPolicy.js';
import {
  PAGES_RATELIMIT_GOOGLE_PER_MIN,
  allowRequest,
  createDefaultOnRateLimiter,
  sameSiteViolation,
} from '../../_lib.js';

const NEARBY_UPSTREAM = 'https://places.googleapis.com/v1/places:searchNearby';
const TEXT_UPSTREAM = 'https://places.googleapis.com/v1/places:searchText';

/** Built once per isolate and reused, so the per-IP window state persists. */
let googleLimiter = createDefaultOnRateLimiter(PAGES_RATELIMIT_GOOGLE_PER_MIN);

/** Test-only: rebuild the limiter so each test starts with an empty window. */
export function resetGoogleLimiterForTest() {
  googleLimiter = createDefaultOnRateLimiter(PAGES_RATELIMIT_GOOGLE_PER_MIN);
}

/** Every error response keeps the `places: []` contract the client expects. */
function placesError(status, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: message, places: [] }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') {
    return placesError(405, 'Method not allowed');
  }

  if (sameSiteViolation(request)) {
    return placesError(403, 'cross-origin requests are rejected');
  }

  if (!allowRequest(googleLimiter(env?.GEV_RATELIMIT_GOOGLE_PER_MIN), request)) {
    return placesError(429, 'Rate limit exceeded', { 'Retry-After': '5' });
  }

  const apiKey = env?.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return placesError(503, 'GOOGLE_MAPS_API_KEY is not set');
  }

  const url = new URL(request.url);
  const subpath = url.pathname.replace(/\/+$/, '').replace(/.*\/api\/google/, '');

  if (subpath === '/nearby-places') return nearbyPlaces(url, apiKey);
  if (subpath === '/text-search') return textSearch(url, apiKey);
  return placesError(404, 'not_found');
}

async function nearbyPlaces(url, apiKey) {
  // parseCoordinateParam treats a MISSING or blank param as NaN, not 0 —
  // `Number(null)` is 0, which used to query Google for 0°N 0°E. Shared with
  // the dev middleware (both runtimes import the same parser).
  const latitude = parseCoordinateParam(url.searchParams.get('lat'));
  const longitude = parseCoordinateParam(url.searchParams.get('lon'));
  const radiusM = Math.max(
    GOOGLE_NEARBY_RADIUS_MIN_M,
    Math.min(GOOGLE_NEARBY_RADIUS_MAX_M, Number(url.searchParams.get('radiusM')) || GOOGLE_NEARBY_RADIUS_DEFAULT_M),
  );
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return placesError(400, 'Valid lat and lon are required');
  }

  try {
    const response = await fetch(NEARBY_UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': GOOGLE_NEARBY_FIELD_MASK,
      },
      body: JSON.stringify(buildNearbyRequestBody({ latitude, longitude, radiusM })),
    });
    return placesResponse(response, latitude, longitude, 'nearby');
  } catch (error) {
    return placesError(502, error?.message || 'Google Places request failed');
  }
}

async function textSearch(url, apiKey) {
  const textQuery = String(url.searchParams.get('q') || '').trim();
  // parseCoordinateParam: missing/blank → NaN (not 0). Same fix as
  // nearby-places above.
  const latitude = parseCoordinateParam(url.searchParams.get('lat'));
  const longitude = parseCoordinateParam(url.searchParams.get('lon'));
  const radiusM = Math.max(
    GOOGLE_TEXT_RADIUS_MIN_M,
    Math.min(GOOGLE_TEXT_RADIUS_MAX_M, Number(url.searchParams.get('radiusM')) || GOOGLE_TEXT_RADIUS_DEFAULT_M),
  );
  // Range-validate, not just finite-validate: lat=999 is finite but an
  // invalid latitude for the Places API (upstream audit #19).
  const validLatitude = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90;
  const validLongitude = Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
  if (!textQuery || !validLatitude || !validLongitude) {
    return placesError(400, 'q, lat and lon are required (lat in [-90,90], lon in [-180,180])');
  }

  try {
    const response = await fetch(TEXT_UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': GOOGLE_TEXT_FIELD_MASK,
      },
      body: JSON.stringify(buildTextSearchRequestBody({ textQuery, latitude, longitude, radiusM })),
    });
    return placesResponse(response, latitude, longitude, 'text');
  } catch (error) {
    return placesError(502, error?.message || 'Google Places request failed');
  }
}

/** Shared upstream exit: status verbatim, normalized places, error surface. */
async function placesResponse(response, latitude, longitude, kind) {
  const data = await response.json().catch(() => ({}));
  const places = kind === 'nearby'
    ? normalizeNearbyPlaces(data, latitude, longitude)
    : normalizeTextPlaces(data, latitude, longitude);
  return new Response(JSON.stringify({
    places,
    error: response.ok ? null : data.error?.message || 'Google Places request failed',
  }), {
    status: response.ok ? 200 : response.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
