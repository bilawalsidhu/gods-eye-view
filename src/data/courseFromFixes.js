/**
 * The course of a contact whose feed reports neither a ground track nor a
 * true heading, read from its own fixes.
 *
 * The course runs from an anchor fix to the newest fix once they are at least
 * COURSE_FROM_FIXES_MIN_M apart; the anchor then moves to the newest fix.
 * Nearer fixes leave the anchor where it is, so frequent fixes of a slow
 * aircraft still add up to a course, while position noise on a parked one
 * never makes one. A fix that does not move time on by a second (a repeat, or
 * an older position from another feed) never moves the anchor or gives a
 * course, and neither does one reported slower than
 * COURSE_FROM_FIXES_MIN_SPEED_MPS.
 */
import { approxDistanceKm } from './approxDistance.js';

/** Metres between fixes before a course is read from them. */
export const COURSE_FROM_FIXES_MIN_M = 30;
/** A contact reported slower than this (m/s) is standing: no course is read. */
export const COURSE_FROM_FIXES_MIN_SPEED_MPS = 2;

/**
 * Initial great-circle bearing from one point to another, in degrees from
 * true north (0–360), or null when either is missing or they are less than
 * COURSE_FROM_FIXES_MIN_M apart.
 */
export function courseBetweenFixes(fromLat, fromLon, toLat, toLon) {
  if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) return null;
  if (
    approxDistanceKm(fromLat, fromLon, toLat, toLon) * 1000 <
    COURSE_FROM_FIXES_MIN_M
  )
    return null;
  const φ1 = (fromLat * Math.PI) / 180;
  const φ2 = (toLat * Math.PI) / 180;
  const Δλ = ((toLon - fromLon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Read a course from a new fix.
 * @param {{lat: number, lon: number, ms: number}|null|undefined} anchor The
 *   anchor fix kept from the last call (null at first).
 * @param {{lat: number, lon: number, ms: number, speedMps?: number|null}} fix
 * @returns {{courseDeg: number|null, anchor: {lat: number, lon: number, ms: number}|null}}
 *   The course, or null when none can be read, and the anchor to keep.
 */
export function courseFromFixes(anchor, { lat, lon, ms, speedMps = null }) {
  const keep = anchor ?? null;
  if (![lat, lon, ms].every(Number.isFinite))
    return { courseDeg: null, anchor: keep };
  if (!keep) return { courseDeg: null, anchor: { lat, lon, ms } };
  if (ms < keep.ms + 1000) return { courseDeg: null, anchor: keep };
  if (Number.isFinite(speedMps) && speedMps < COURSE_FROM_FIXES_MIN_SPEED_MPS)
    return { courseDeg: null, anchor: keep };
  const courseDeg = courseBetweenFixes(keep.lat, keep.lon, lat, lon);
  if (courseDeg === null) return { courseDeg: null, anchor: keep };
  return { courseDeg, anchor: { lat, lon, ms } };
}
