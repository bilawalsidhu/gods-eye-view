// src/data/routePlausible.js
/**
 * Is an adsbdb scheduled route consistent with where the plane actually is and
 * what it is doing? adsbdb returns the scheduled route for a callsign, which
 * is sometimes the wrong leg — reject a route rather than display a wrong one.
 * Adapted from skylight (MIT) web/src/display/renderer.ts routePlausible(),
 * with the vertical-trend check made observer-free (skylight anchors it to a
 * fixed ground station; GEV has no observer, so the check is anchored to the
 * PLANE: climbing hard + low → its origin should be nearby; descending hard +
 * low → its destination should be nearby).
 */

const D2R = Math.PI / 180;
const R_KM = 6371;

/**
 * Haversine great-circle distance in km.
 * @param {number} lat1 Latitude of the first point, in decimal degrees.
 * @param {number} lon1 Longitude of the first point, in decimal degrees.
 * @param {number} lat2 Latitude of the second point, in decimal degrees.
 * @param {number} lon2 Longitude of the second point, in decimal degrees.
 * @returns {number} Separation of the two points along the sphere surface, km.
 */
export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dp = (lat2 - lat1) * D2R;
  const dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Initial great-circle bearing from p1 toward p2, measured clockwise from
 * true north. Shared by {@link crossTrackKm}; not part of the public surface.
 * @param {number} lat1 Latitude of the origin point, in decimal degrees.
 * @param {number} lon1 Longitude of the origin point, in decimal degrees.
 * @param {number} lat2 Latitude of the target point, in decimal degrees.
 * @param {number} lon2 Longitude of the target point, in decimal degrees.
 * @returns {number} Bearing in radians, in [-PI, PI].
 */
function bearingRad(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x);
}

/**
 * Signed cross-track distance (km) of point from the great circle p1→p2.
 * @param {number} lat Latitude of the point being tested, in decimal degrees.
 * @param {number} lon Longitude of the point being tested, in decimal degrees.
 * @param {number} lat1 Latitude of the path start, in decimal degrees.
 * @param {number} lon1 Longitude of the path start, in decimal degrees.
 * @param {number} lat2 Latitude of the path end, in decimal degrees.
 * @param {number} lon2 Longitude of the path end, in decimal degrees.
 * @returns {number} Perpendicular offset in km — positive when the point lies
 *   left of the p1→p2 heading, negative when right, 0 when on the path.
 */
export function crossTrackKm(lat, lon, lat1, lon1, lat2, lon2) {
  const d13 = greatCircleKm(lat1, lon1, lat, lon) / R_KM;
  const b13 = bearingRad(lat1, lon1, lat, lon);
  const b12 = bearingRad(lat1, lon1, lat2, lon2);
  return Math.asin(Math.sin(d13) * Math.sin(b13 - b12)) * R_KM;
}

const NEAR_ENDPOINT_KM = 130;
const CROSS_TRACK_KM = 200;
const LOW_ALT_M = 3700;        // ~12 000 ft
const VERT_TREND_MPS = 2;      // ~400 fpm
const LOCAL_AIRPORT_KM = 150;

/**
 * @param {object} p - The live contact and the scheduled route under test.
 * @param {number} p.latDeg - Plane's current latitude (degrees).
 * @param {number} p.lonDeg - Plane's current longitude (degrees).
 * @param {number|null} [p.altitudeM] - Barometric/geo altitude in metres;
 *   undefined treated as unknown, which skips the vertical-trend check.
 * @param {number|null} [p.verticalRateMps] — positive = climbing
 * @param {{lat:number|null, lon:number|null}|null} [p.origin] - adsbdb origin
 *   airport, in decimal degrees, when the route carries one.
 * @param {{lat:number|null, lon:number|null}|null} [p.destination] - adsbdb
 *   destination airport, in decimal degrees, when the route carries one.
 * @returns {boolean} false ONLY when the route is confidently wrong.
 */
export function routePlausible({ latDeg, lonDeg, altitudeM = null, verticalRateMps = null, origin = null, destination = null }) {
  const haveO = Number.isFinite(origin?.lat) && Number.isFinite(origin?.lon);
  const haveD = Number.isFinite(destination?.lat) && Number.isFinite(destination?.lon);
  if (!haveO && !haveD) return true; // no coordinates — cannot judge, do not hide

  // (a) Geographic consistency: near an endpoint, or roughly on the path.
  const near = (pt) => greatCircleKm(latDeg, lonDeg, pt.lat, pt.lon) < NEAR_ENDPOINT_KM;
  let geomOk = (haveO && near(origin)) || (haveD && near(destination));
  if (!geomOk && haveO && haveD) {
    geomOk = Math.abs(crossTrackKm(latDeg, lonDeg, origin.lat, origin.lon, destination.lat, destination.lon)) < CROSS_TRACK_KM;
  } else if (!geomOk) {
    geomOk = true; // only one endpoint known and not near — cannot judge, allow
  }
  if (!geomOk) return false;

  // (b) Vertical-trend consistency for low traffic (observer-free adaptation).
  if (
    Number.isFinite(altitudeM) && altitudeM < LOW_ALT_M &&
    Number.isFinite(verticalRateMps) && Math.abs(verticalRateMps) > VERT_TREND_MPS
  ) {
    if (verticalRateMps > 0) {
      if (haveO && greatCircleKm(latDeg, lonDeg, origin.lat, origin.lon) > LOCAL_AIRPORT_KM) return false; // departing — origin should be local
    } else {
      if (haveD && greatCircleKm(latDeg, lonDeg, destination.lat, destination.lon) > LOCAL_AIRPORT_KM) return false; // arriving — destination should be local
    }
  }
  return true;
}
