/**
 * @file Pure geometry helpers for the traffic layer's viewport fetch bounds.
 *
 * `camera.computeViewRectangle()` spans toward the horizon at oblique pitch, so its
 * midpoint can sit tens of km from what the user looks at. The fetch center is derived
 * from the camera's look-at ground point
 * (`camera.pickEllipsoid` at canvas center — the globe is hidden under Google
 * 3D tiles, so `scene.globe.pick` is not reliable), falling back to the camera
 * nadir, and pulled back toward nadir when the look-at point is beyond a
 * horizon-gaze cap. Kept Cesium-free so it can be unit-tested with node:test.
 *
 * @module data/trafficBounds
 */

import {
  destinationPoint,
  greatCircleKm,
  initialBearingDeg,
  isGeoPoint,
} from '../geoDistance.js';
import { wrapLongitude } from '../geo/vector.js';

/**
 * Derive the road-fetch center from the camera's look-at ground point.
 *
 * Rules:
 *  - No usable hit (pickEllipsoid returned undefined → non-finite hit coords):
 *    fall back to the camera nadir.
 *  - Hit within `maxPullKm` of nadir: use the hit verbatim (normal oblique view).
 *  - Hit farther than `maxPullKm` (horizon gaze): pull it back toward nadir to
 *    exactly `maxPullKm` along the nadir→hit great-circle bearing. Traffic only
 *    activates below 8 km camera altitude, so a look-at point farther than
 *    ~12 km is horizon-gazing, not something the user can see roads at.
 *
 * @param {Object} args
 * @param {number} args.nadirLat - Camera nadir latitude (degrees).
 * @param {number} args.nadirLon - Camera nadir longitude (degrees).
 * @param {number} [args.hitLat] - pickEllipsoid ground-hit latitude (degrees), if any.
 * @param {number} [args.hitLon] - pickEllipsoid ground-hit longitude (degrees), if any.
 * @param {number} [args.maxPullKm=12] - Max great-circle distance from nadir.
 * @returns {{lat:number, lon:number, source:'hit'|'nadir'|'pulled'}}
 *   The fetch center and which rule produced it.
 */
export function deriveFetchCenter({
  nadirLat,
  nadirLon,
  hitLat,
  hitLon,
  maxPullKm = 12,
}) {
  if (!isGeoPoint({ lat: hitLat, lon: hitLon })) {
    return { lat: nadirLat, lon: nadirLon, source: 'nadir' };
  }
  const distKm = greatCircleKm(
    { lat: nadirLat, lon: nadirLon },
    { lat: hitLat, lon: hitLon },
  );
  if (distKm <= maxPullKm) {
    return { lat: hitLat, lon: hitLon, source: 'hit' };
  }
  const pulled = destinationPoint(
    nadirLat,
    nadirLon,
    initialBearingDeg(nadirLat, nadirLon, hitLat, hitLon),
    maxPullKm * 1000,
  );
  return { lat: pulled.lat, lon: wrapLongitude(pulled.lon), source: 'pulled' };
}

/**
 * Wrapped longitude span between two meridians, in degrees.
 *
 * Longitude is cyclic, so a box crossing the antimeridian (±180°) has
 * `east < west` (e.g. `west = 179.98, east = -179.98`). A plain `east - west`
 * goes negative in that case; wrap through 360° instead.
 *
 * @param {number} west - West edge longitude (degrees).
 * @param {number} east - East edge longitude (degrees).
 * @returns {number} Span in degrees, always >= 0.
 */
function longitudeSpanDeg(west, east) {
  const raw = east - west;
  return raw >= 0 ? raw : raw + 360;
}

/** Keep a monotonic longitude range inside the traffic source's legal domain. */
function boundedLongitudeRange(center, span) {
  let west = center - span / 2;
  let east = center + span / 2;
  if (east > 180) {
    west -= east - 180;
    east = 180;
  }
  if (west < -180) {
    east += -180 - west;
    west = -180;
  }
  return { west, east };
}

/**
 * Clamp a bounding box's spans to `maxSpanDeg` and recenter it on `center`.
 *
 * Preserves the pre-C4 span semantics (each axis capped at 0.05° ≈ 5.5 km)
 * but centers the box on the derived look-at point instead of the view
 * rectangle's midpoint. At the antimeridian the whole box shifts just far
 * enough to remain inside [-180, 180], because the road source accepts one
 * monotonic Overpass bounding box. Idempotent when `center` is the box's own
 * midpoint.
 *
 * Longitude is handled as a cyclic axis for the span calculation, so the
 * input span wraps correctly across the antimeridian. Output remains
 * monotonic because callers such as `getBoundsCenter` and `boundsOverlap`
 * rely on `west <= east`.
 *
 * @param {{south:number, west:number, north:number, east:number}} bounds
 *   Source bounds (span donor).
 * @param {{lat:number, lon:number}} center - Fetch center (degrees).
 * @param {number} [maxSpanDeg=0.05] - Max span per axis in degrees.
 * @returns {{south:number, west:number, north:number, east:number}} Clamped bounds.
 */
export function clampBoundsAroundCenter(bounds, center, maxSpanDeg = 0.05) {
  const latSpan = Math.min(bounds.north - bounds.south, maxSpanDeg);
  const lonSpan = Math.min(
    longitudeSpanDeg(bounds.west, bounds.east),
    maxSpanDeg,
  );
  const longitude = boundedLongitudeRange(center.lon, lonSpan);
  return {
    south: center.lat - latSpan / 2,
    north: center.lat + latSpan / 2,
    ...longitude,
  };
}
