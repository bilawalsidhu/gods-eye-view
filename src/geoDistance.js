/**
 * Canonical geographic point used by shared spatial utilities.
 *
 * @typedef {{lat: number, lon: number}} GeoPoint
 */

/** IUGG mean spherical Earth radius, in kilometres. */
export const EARTH_RADIUS_KM = 6371.0088;

const DEGREES_TO_RADIANS = Math.PI / 180;

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
