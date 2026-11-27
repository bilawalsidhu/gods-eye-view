/**
 * Canonical geographic point used by shared spatial utilities.
 *
 * @typedef {{lat: number, lon: number}} GeoPoint
 */

/** IUGG mean spherical Earth radius, in kilometres. */
export const EARTH_RADIUS_KM = 6371.0088;

/** The same mean radius, in metres. */
export const EARTH_RADIUS_M = 6371008.8;

const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

/**
 * Whether a value is a canonical, finite WGS84-style point in degrees.
 * Longitudes are not implicitly wrapped because an out-of-range value usually
 * indicates a broken coordinate contract at the caller.
 *
 * @param {*} point
 * @returns {point is GeoPoint}
 */
export function isGeoPoint(point) {
  return (
    Number.isFinite(point?.lat) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    Number.isFinite(point?.lon) &&
    point.lon >= -180 &&
    point.lon <= 180
  );
}

/**
 * Great-circle distance in kilometres between two `{ lat, lon }` points.
 *
 * `{ lat, lon }` is the canonical shared coordinate representation. Invalid,
 * missing, non-finite, or out-of-range coordinates return `Infinity`, which
 * keeps invalid points out of threshold and nearest-neighbour selections.
 *
 * @param {GeoPoint} from
 * @param {GeoPoint} to
 * @returns {number}
 */
export function greatCircleKm(from, to) {
  if (!isGeoPoint(from) || !isGeoPoint(to)) return Number.POSITIVE_INFINITY;

  const latitude1 = from.lat * DEGREES_TO_RADIANS;
  const latitude2 = to.lat * DEGREES_TO_RADIANS;
  const latitudeDelta = (to.lat - from.lat) * DEGREES_TO_RADIANS;
  const longitudeDelta = (to.lon - from.lon) * DEGREES_TO_RADIANS;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2;
  const bounded = Math.min(1, Math.max(0, haversine));
  return (
    2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(bounded), Math.sqrt(1 - bounded))
  );
}

/**
 * Great-circle distance in metres, with the same point and invalid-input
 * contract as {@link greatCircleKm}.
 *
 * @param {GeoPoint} from
 * @param {GeoPoint} to
 * @returns {number}
 */
export function greatCircleMeters(from, to) {
  return greatCircleKm(from, to) * 1000;
}

/** Initial great-circle bearing from point 1 to point 2, in radians from north. */
export function initialBearingRad(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEGREES_TO_RADIANS;
  const p2 = lat2 * DEGREES_TO_RADIANS;
  const dl = (lon2 - lon1) * DEGREES_TO_RADIANS;
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x);
}

/** Initial great-circle bearing from point 1 to point 2, in degrees [0, 360). */
export function initialBearingDeg(lat1, lon1, lat2, lon2) {
  return (
    (initialBearingRad(lat1, lon1, lat2, lon2) * RADIANS_TO_DEGREES + 360) % 360
  );
}

/**
 * The point `distanceM` along a great circle from a start point and bearing,
 * in degrees; the longitude is not wrapped.
 */
export function destinationPoint(
  latDeg,
  lonDeg,
  bearingDeg,
  distanceM,
  radiusM = EARTH_RADIUS_M,
) {
  const delta = distanceM / radiusM;
  const lat1 = latDeg * DEGREES_TO_RADIANS;
  const lon1 = lonDeg * DEGREES_TO_RADIANS;
  const theta = bearingDeg * DEGREES_TO_RADIANS;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(delta) +
      Math.cos(lat1) * Math.sin(delta) * Math.cos(theta),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: lat2 * RADIANS_TO_DEGREES, lon: lon2 * RADIANS_TO_DEGREES };
}

/**
 * Ray-cast (even-odd) point-in-ring test. Ring = [[lon,lat], …], open or
 * closed. Degenerate rings (<3 verts) are never containing.
 * @param {Array<[number,number]>} ring
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function pointInRing(ring, lat, lon) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
