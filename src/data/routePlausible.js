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

import { EARTH_RADIUS_KM, greatCircleKm, isGeoPoint } from '../geoDistance.js';

const D2R = Math.PI / 180;

function bearingRad(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R;
  const p2 = lat2 * D2R;
  const dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x =
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x);
}

/** Signed cross-track distance (km) of point from the great circle p1→p2. */
export function crossTrackKm(lat, lon, lat1, lon1, lat2, lon2) {
  const d13 =
    greatCircleKm({ lat: lat1, lon: lon1 }, { lat, lon }) / EARTH_RADIUS_KM;
  const b13 = bearingRad(lat1, lon1, lat, lon);
  const b12 = bearingRad(lat1, lon1, lat2, lon2);
  return Math.asin(Math.sin(d13) * Math.sin(b13 - b12)) * EARTH_RADIUS_KM;
}

const NEAR_ENDPOINT_KM = 130;
const CROSS_TRACK_KM = 200;
const LOW_ALT_M = 3700; // ~12 000 ft
const VERT_TREND_MPS = 2; // ~400 fpm
const LOCAL_AIRPORT_KM = 150;

/**
 * @param {object} p
 * @param {number} p.latDeg / p.lonDeg — plane's current position
 * @param {number|null} [p.altitudeM]
 * @param {number|null} [p.verticalRateMps] — positive = climbing
 * @param {{lat:number|null, lon:number|null}|null} [p.origin]
 * @param {{lat:number|null, lon:number|null}|null} [p.destination]
 * @returns {boolean} false ONLY when the route is confidently wrong.
 */
export function routePlausible({
  latDeg,
  lonDeg,
  altitudeM = null,
  verticalRateMps = null,
  origin = null,
  destination = null,
}) {
  const position = { lat: latDeg, lon: lonDeg };
  if (!isGeoPoint(position)) return true;
  const haveO = isGeoPoint(origin);
  const haveD = isGeoPoint(destination);
  if (!haveO && !haveD) return true; // no coordinates — cannot judge, do not hide

  // (a) Geographic consistency: near an endpoint, or roughly on the path.
  const near = (point) => greatCircleKm(position, point) < NEAR_ENDPOINT_KM;
  let geomOk = (haveO && near(origin)) || (haveD && near(destination));
  if (!geomOk && haveO && haveD) {
    geomOk =
      Math.abs(
        crossTrackKm(
          latDeg,
          lonDeg,
          origin.lat,
          origin.lon,
          destination.lat,
          destination.lon,
        ),
      ) < CROSS_TRACK_KM;
  } else if (!geomOk) {
    geomOk = true; // only one endpoint known and not near — cannot judge, allow
  }
  if (!geomOk) return false;

  // (b) Vertical-trend consistency for low traffic (observer-free adaptation).
  if (
    Number.isFinite(altitudeM) &&
    altitudeM < LOW_ALT_M &&
    Number.isFinite(verticalRateMps) &&
    Math.abs(verticalRateMps) > VERT_TREND_MPS
  ) {
    if (verticalRateMps > 0) {
      if (haveO && greatCircleKm(position, origin) > LOCAL_AIRPORT_KM)
        return false; // departing — origin should be local
    } else {
      if (haveD && greatCircleKm(position, destination) > LOCAL_AIRPORT_KM)
        return false; // arriving — destination should be local
    }
  }
  return true;
}
