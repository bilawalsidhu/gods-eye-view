// src/data/googlePlacesPolicy.js
/**
 * Shared Google Places (Places API New) policy: request builders, field
 * masks, response normalization, and the context-priority ranking used by the
 * HUD scene-summary enrichment.
 *
 * Imported by BOTH runtimes — the dev middlewares in `vite/proxies/*`
 * (`googlePlacesContextProxy`) and the Pages Function
 * (`functions/api/google/[[path]].js`) — so the key-holding proxy behaves
 * identically in dev and production.
 *
 * Worker-safe only: plain objects/JSON, no `node:*`, no `Buffer`.
 *
 * @module src/data/googlePlacesPolicy
 */

/** Field mask for Nearby Search (what the HUD context needs, nothing more). */
export const GOOGLE_NEARBY_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.shortFormattedAddress',
  'places.location',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.types',
].join(',');

/** Field mask for Text Search (adds `viewport` for grounds-disc sizing). */
export const GOOGLE_TEXT_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.viewport',
  'places.primaryType',
  'places.types',
].join(',');

/** Nearby Search caps results at 20 (the Places API maximum). */
export const GOOGLE_NEARBY_MAX_RESULTS = 20;
/** Text Search asks for a handful of well-biased candidates. */
export const GOOGLE_TEXT_MAX_RESULTS = 5;

/** Dev parity for the nearby radius clamp. */
export const GOOGLE_NEARBY_RADIUS_MIN_M = 25;
export const GOOGLE_NEARBY_RADIUS_MAX_M = 5000;
export const GOOGLE_NEARBY_RADIUS_DEFAULT_M = 250;
/** Dev parity for the text-search bias radius clamp. */
export const GOOGLE_TEXT_RADIUS_MIN_M = 50;
export const GOOGLE_TEXT_RADIUS_MAX_M = 50000;
export const GOOGLE_TEXT_RADIUS_DEFAULT_M = 4000;

/**
 * Context ranking for the HUD summary: landmarks and attractions carry the
 * scene; amenities are last resorts. Higher wins.
 * @param {string[]} types
 */
export function placeContextPriority(types) {
  const typeSet = new Set(types);
  if (typeSet.has('historical_landmark') || typeSet.has('monument')) return 100;
  if (typeSet.has('tourist_attraction') || typeSet.has('museum')) return 90;
  if (typeSet.has('premise') || typeSet.has('street_address')) return 75;
  if (typeSet.has('point_of_interest')) return 60;
  if (typeSet.has('public_bathroom')) return 10;
  return 40;
}

/**
 * Flat-earth equirectangular distance in whole meters — plenty at HUD context
 * radii (<= 50 km) and cheap enough to run per place per request.
 * Non-finite inputs sort last via MAX_SAFE_INTEGER.
 */
export function approximateDistanceM(latA, lonA, latB, lonB) {
  if (![latA, lonA, latB, lonB].every(Number.isFinite)) return Number.MAX_SAFE_INTEGER;
  const latitudeScale = 111320;
  const longitudeScale = latitudeScale * Math.cos((latA * Math.PI) / 180);
  return Math.round(Math.hypot(
    (latB - latA) * latitudeScale,
    (lonB - lonA) * longitudeScale,
  ));
}

/** Request body for `places:searchNearby` (DISTANCE-ranked circle). */
export function buildNearbyRequestBody({ latitude, longitude, radiusM }) {
  return {
    maxResultCount: GOOGLE_NEARBY_MAX_RESULTS,
    rankPreference: 'DISTANCE',
    locationRestriction: {
      circle: {
        center: { latitude, longitude },
        radius: radiusM,
      },
    },
  };
}

/**
 * Parse a `lat`/`lon` query param into a Number, treating MISSING or BLANK as
 * invalid (NaN) rather than 0. `Number(null)` and `Number('')` are both 0,
 * which would otherwise silently query Google for 0°N 0°E (Gulf of Guinea)
 * when the client omits a coordinate. Shared by both runtimes.
 */
export function parseCoordinateParam(value) {
  if (value === null || value === undefined || String(value).trim() === '') return Number.NaN;
  return Number(value);
}

/** The scaffolded .env sentinel — a request to configure, not a credential. */
export const GOOGLE_API_KEY_PLACEHOLDER = 'your_google_maps_api_key_here';

/**
 * Resolve the configured GOOGLE_MAPS_API_KEY, treating unset, blank, and the
 * scaffolded placeholder alike as ABSENT. Forwarding the placeholder to
 * Google just 400s ("API key not valid") and makes a placeholder-configured
 * server answer upstream failures instead of its honest keyless contract —
 * which also blinds keyless-detection in the QA probes. Shared by both
 * runtimes so dev and prod degrade identically.
 * @param {?string} value Raw key from the environment.
 * @returns {?string} The usable key, or null when effectively unset.
 */
export function resolveGoogleApiKey(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || trimmed === GOOGLE_API_KEY_PLACEHOLDER) return null;
  return trimmed;
}

/** Request body for `places:searchText` (view-biased). */
export function buildTextSearchRequestBody({ textQuery, latitude, longitude, radiusM }) {
  return {
    textQuery,
    locationBias: {
      circle: {
        center: { latitude, longitude },
        radius: radiusM,
      },
    },
    maxResultCount: GOOGLE_TEXT_MAX_RESULTS,
  };
}

/** Shared per-place projection of the Google result row. */
function basePlace(place, latitude, longitude) {
  const placeLatitude = place.location?.latitude ?? null;
  const placeLongitude = place.location?.longitude ?? null;
  const types = Array.isArray(place.types) ? place.types.slice(0, 8) : [];
  return {
    id: place.id || null,
    name: place.displayName?.text || null,
    latitude: placeLatitude,
    longitude: placeLongitude,
    distanceM: approximateDistanceM(latitude, longitude, placeLatitude, placeLongitude),
    types,
  };
}

/**
 * Normalize a Nearby Search response into the client contract: deduped by
 * name+address, ranked by context priority then distance, capped at 20, with
 * the internal priority field stripped before the wire.
 * @returns {object[]}
 */
export function normalizeNearbyPlaces(data, latitude, longitude) {
  if (!Array.isArray(data?.places)) return [];
  const seenPlaces = new Set();
  return data.places
    .map((place) => {
      const base = basePlace(place, latitude, longitude);
      return {
        ...base,
        address: place.shortFormattedAddress || place.formattedAddress || null,
        primaryType: place.primaryTypeDisplayName?.text || place.primaryType || null,
        contextPriority: placeContextPriority(base.types),
      };
    })
    .filter((place) => {
      const key = `${place.name}:${place.address || ''}`.toLowerCase();
      if (!place.name || seenPlaces.has(key)) return false;
      seenPlaces.add(key);
      return true;
    })
    .sort((a, b) => b.contextPriority - a.contextPriority || a.distanceM - b.distanceM)
    .map(({ contextPriority: _contextPriority, ...place }) => place)
    .slice(0, GOOGLE_NEARBY_MAX_RESULTS);
}

/**
 * Normalize a Text Search response: keeps the viewport box (low/high corners)
 * so the client can size a fallback grounds disc to the real feature.
 * @returns {object[]}
 */
export function normalizeTextPlaces(data, latitude, longitude) {
  if (!Array.isArray(data?.places)) return [];
  return data.places
    .map((place) => {
      const base = basePlace(place, latitude, longitude);
      // Places returns a lat/lng bounding box (low/high corners) framing the
      // place — no polygon, but enough to SIZE a fallback grounds disc to the
      // real feature instead of a blind constant. Normalize to plain numbers.
      const vp = place.viewport;
      const viewport = (
        Number.isFinite(vp?.low?.latitude) && Number.isFinite(vp?.low?.longitude)
        && Number.isFinite(vp?.high?.latitude) && Number.isFinite(vp?.high?.longitude)
      ) ? {
        low: { latitude: vp.low.latitude, longitude: vp.low.longitude },
        high: { latitude: vp.high.latitude, longitude: vp.high.longitude },
      } : null;
      return {
        ...base,
        address: place.formattedAddress || null,
        primaryType: place.primaryType || null,
        viewport,
      };
    })
    .filter((place) => place.name);
}
