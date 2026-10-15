/**
 * @file Pure geometry helpers for the traffic layer's viewport fetch bounds.
 *
 * C4 fix (2026-07-16): `camera.computeViewRectangle()` spans toward the horizon
 * at oblique pitch, and centering the fetch box on the RECTANGLE MIDPOINT put
 * road fetches tens of km from what the user is actually looking at. The fetch
 * center is now derived from the camera's look-at ground point
 * (`camera.pickEllipsoid` at canvas center — the globe is hidden under Google
 * 3D tiles, so `scene.globe.pick` is not reliable), falling back to the camera
 * nadir, and pulled back toward nadir when the look-at point is beyond a
 * horizon-gaze cap. Kept Cesium-free so it can be unit-tested with node:test.
 *
 * @module data/trafficBounds
 */

/** @const {number} Mean Earth radius in km (spherical approximation). */
const EARTH_RADIUS_KM = 6371;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Great-circle distance between two lat/lon points (haversine).
 *
 * @param {number} lat1 - First point latitude (degrees).
 * @param {number} lon1 - First point longitude (degrees).
 * @param {number} lat2 - Second point latitude (degrees).
 * @param {number} lon2 - Second point longitude (degrees).
 * @returns {number} Distance in kilometres.
 */
export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial bearing (radians) from point 1 toward point 2 along the great circle.
 *
 * @param {number} lat1 @param {number} lon1 @param {number} lat2 @param {number} lon2
 * @returns {number} Bearing in radians (0 = north, clockwise).
 */
function initialBearingRad(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x);
}

/**
 * Destination point given a start, an initial bearing, and a distance
 * (spherical direct geodesic).
 *
 * @param {number} lat - Start latitude (degrees).
 * @param {number} lon - Start longitude (degrees).
 * @param {number} bearingRad - Initial bearing (radians, 0 = north).
 * @param {number} distKm - Distance to travel (km).
 * @returns {{lat:number, lon:number}} Destination in degrees.
 */
function destinationPoint(lat, lon, bearingRad, distKm) {
  const delta = distKm / EARTH_RADIUS_KM;
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(delta) +
      Math.cos(p1) * Math.sin(delta) * Math.cos(bearingRad),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(delta) * Math.cos(p1),
      Math.cos(delta) - Math.sin(p1) * Math.sin(p2),
    );
  // Normalize longitude to [-180, 180)
  const lonDeg = ((toDeg(l2) + 540) % 360) - 180;
  return { lat: toDeg(p2), lon: lonDeg };
}

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
  if (!Number.isFinite(hitLat) || !Number.isFinite(hitLon)) {
    return { lat: nadirLat, lon: nadirLon, source: 'nadir' };
  }
  const distKm = greatCircleKm(nadirLat, nadirLon, hitLat, hitLon);
  if (distKm <= maxPullKm) {
    return { lat: hitLat, lon: hitLon, source: 'hit' };
  }
  const bearing = initialBearingRad(nadirLat, nadirLon, hitLat, hitLon);
  const pulled = destinationPoint(nadirLat, nadirLon, bearing, maxPullKm);
  return { lat: pulled.lat, lon: pulled.lon, source: 'pulled' };
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
