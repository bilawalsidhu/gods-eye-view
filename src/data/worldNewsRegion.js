/**
 * @file Pure geometry and query rules for World News "this view" fetching.
 *
 * The provider's `location-filter=lat,lon,radiusKm` matches the geocoded
 * CENTROID of a location entity, not a polygon, and the radius is hard-capped
 * at 100 km (500 answers HTTP 400 "Distance must be between 1 and 100
 * kilometers", verified 2026-09-21). So this is a metro-scale instrument: it
 * answers "what is the news around this city", never "what is the news in
 * Russia" — a country entity geocodes to its centroid (Russia at 60N 100E),
 * which no 100 km circle over a city will contain.
 *
 * A view wider than the cap therefore falls back to the global newest-first
 * feed rather than silently fetching a circle that does not cover what the
 * operator is looking at.
 *
 * Kept Cesium-free and I/O-free so the proxy, the layer and node:test can all
 * share one definition — the role src/data/worldNewsArticles.js plays for
 * records.
 *
 * @module data/worldNewsRegion
 */

import { greatCircleKm } from './trafficBounds.js';

/** Radii the provider accepts, smallest first. Hard upstream cap is 100. */
export const NEWS_REGION_RADII_KM = Object.freeze([25, 50, 100]);
export const NEWS_REGION_MAX_RADIUS_KM = 100;
export const NEWS_REGION_MIN_RADIUS_KM = 1;
/**
 * Grid the fetch centre is snapped to, in degrees. Panning less than this
 * reuses the cached batch instead of buying a near-identical one; 0.5° is
 * ~55 km north-south, comfortably inside the smallest radius.
 */
export const NEWS_REGION_GRID_DEG = 0.5;

const clampLat = (lat) => Math.max(-90, Math.min(90, lat));

/** Wrap to [-180, 180) so a key is stable either side of the dateline. */
export function wrapLongitude(lon) {
  if (!Number.isFinite(lon)) return 0;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  // -180 and 180 are the same meridian; pick one so the key never forks.
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Snap a point to the shared grid so nearby viewports share a cache key.
 * @param {number} lat Degrees.
 * @param {number} lon Degrees.
 * @returns {{lat:number, lon:number}} Grid point, one decimal place.
 */
export function quantizeRegionPoint(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { lat: 0, lon: 0 };
  const snap = (value) =>
    Math.round(
      Math.round(value / NEWS_REGION_GRID_DEG) * NEWS_REGION_GRID_DEG * 10,
    ) / 10;
  return { lat: clampLat(snap(lat)), lon: wrapLongitude(snap(lon)) };
}

/**
 * Smallest accepted radius covering `km`, or null when nothing does.
 * @param {number} km Desired radius.
 * @returns {number|null}
 */
export function snapRegionRadiusKm(km) {
  if (!Number.isFinite(km) || km <= 0) return null;
  return NEWS_REGION_RADII_KM.find((radius) => km <= radius) ?? null;
}

/**
 * Half the diagonal of a view rectangle, in kilometres — the radius a circle
 * needs to cover it. Rectangles are clamped to a hemisphere first: a camera
 * looking at the horizon reports a span approaching the whole globe, and that
 * is a global view, not a very large circle.
 *
 * @param {{west:number, south:number, east:number, north:number}} rect Degrees.
 * @returns {number|null} Radius in km, or null when the rectangle is unusable.
 */
export function viewRadiusKm(rect) {
  if (!rect) return null;
  const { west, south, east, north } = rect;
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (north <= south) return null;
  let lonSpan = east - west;
  if (lonSpan <= 0) lonSpan += 360;
  if (lonSpan > 180 || north - south > 90) return Number.POSITIVE_INFINITY;
  const midLat = (north + south) / 2;
  const midLon = wrapLongitude(west + lonSpan / 2);
  return greatCircleKm(
    midLat,
    midLon,
    north,
    wrapLongitude(midLon + lonSpan / 2),
  );
}

/**
 * Decide which band a view falls into and build its descriptor.
 *
 * @param {object} args
 * @param {{west:number, south:number, east:number, north:number}|null} args.rect
 *   Camera view rectangle in degrees, or null when the camera sees no globe.
 * @param {{lat:number, lon:number}|null} [args.lookAt] Ground point the camera
 *   is actually aimed at (see deriveFetchCenter) — preferred over the
 *   rectangle midpoint, which drifts toward the horizon at oblique pitch.
 * @param {string} [args.language] ISO 639-1 code, '' meaning all languages.
 * @returns {{band:'local'|'global', key:string, center?:{lat:number,lon:number},
 *   radiusKm?:number}}
 */
export function resolveNewsRegion({ rect, lookAt = null, language = 'en' }) {
  const lang =
    String(language || '')
      .trim()
      .toLowerCase() || 'all';
  const radiusKm = snapRegionRadiusKm(viewRadiusKm(rect));
  const centerLat = Number.isFinite(lookAt?.lat)
    ? lookAt.lat
    : rect && Number.isFinite(rect.north)
      ? (rect.north + rect.south) / 2
      : null;
  const centerLon = Number.isFinite(lookAt?.lon)
    ? lookAt.lon
    : rect && Number.isFinite(rect.east)
      ? (rect.east + rect.west) / 2
      : null;
  if (radiusKm === null || centerLat === null || centerLon === null) {
    return { band: 'global', key: `g:${lang}` };
  }
  const center = quantizeRegionPoint(centerLat, centerLon);
  return {
    band: 'local',
    key: `l:${lang}:${center.lat}:${center.lon}:${radiusKm}`,
    center,
    radiusKm,
  };
}

/**
 * Validate a region carried on the proxy's query string.
 *
 * Returns an explicit error rather than falling back to the global feed,
 * because the provider IGNORES unknown parameters and answers 200 with the
 * full global result set (verified 2026-09-21 with `bogus-parameter=zzz` →
 * 50,163 articles). A malformed region must never be cached under a region
 * key as if it were regional news.
 *
 * @param {URLSearchParams} params
 * @param {string} [language]
 * @returns {{ok:true, region:object}|{ok:false, reason:string}}
 */
export function parseNewsRegionQuery(params, language = 'en') {
  const raw = params?.get?.('region');
  if (raw == null || raw === '') return { ok: true, region: null };
  if (raw !== 'view') return { ok: false, reason: 'unknown region mode' };
  // Read through a guard: Number(null) is 0 and Number('') is 0, so a MISSING
  // coordinate would otherwise validate as the Gulf of Guinea and be fetched.
  const number = (name) => {
    const value = params.get(name);
    return value == null || String(value).trim() === '' ? NaN : Number(value);
  };
  const lat = number('lat');
  const lon = number('lon');
  const radiusKm = number('radius');
  if (!Number.isFinite(lat) || Math.abs(lat) > 90)
    return { ok: false, reason: 'lat out of range' };
  if (!Number.isFinite(lon) || Math.abs(lon) > 180)
    return { ok: false, reason: 'lon out of range' };
  if (
    !Number.isFinite(radiusKm) ||
    radiusKm < NEWS_REGION_MIN_RADIUS_KM ||
    radiusKm > NEWS_REGION_MAX_RADIUS_KM
  )
    return { ok: false, reason: 'radius must be 1-100 km' };
  const lang =
    String(language || '')
      .trim()
      .toLowerCase() || 'all';
  const center = quantizeRegionPoint(lat, lon);
  const snapped = snapRegionRadiusKm(radiusKm) ?? NEWS_REGION_MAX_RADIUS_KM;
  return {
    ok: true,
    region: {
      band: 'local',
      key: `l:${lang}:${center.lat}:${center.lon}:${snapped}`,
      center,
      radiusKm: snapped,
    },
  };
}

/**
 * Query string the browser appends when asking for the current view.
 * @param {{center:{lat:number,lon:number}, radiusKm:number}|null} region
 * @returns {string} e.g. 'region=view&lat=55.5&lon=37.5&radius=50', or ''.
 */
export function newsRegionQueryString(region) {
  if (!region?.center || !Number.isFinite(region.radiusKm)) return '';
  const { lat, lon } = region.center;
  return `region=view&lat=${lat}&lon=${lon}&radius=${region.radiusKm}`;
}

/**
 * Operator-facing description of a region, for the layer row.
 * @param {{center:{lat:number,lon:number}, radiusKm:number}|null} region
 * @returns {string}
 */
export function describeNewsRegion(region) {
  if (!region?.center || !Number.isFinite(region.radiusKm))
    return 'whole earth';
  const { lat, lon } = region.center;
  return `within ${region.radiusKm} km of ${lat.toFixed(1)}, ${lon.toFixed(1)}`;
}
