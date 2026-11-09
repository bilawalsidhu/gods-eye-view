/**
 * Bridge radar policy: the range steps, the range rings and the heading-up
 * projection of nearby AIS vessels onto the radar's range circle. Pure: no
 * DOM, no Cesium and no translated text; the Cockpit words the labels.
 */
import {
  bearingBetweenCoordinates,
  normalizeHeading,
  relativeBearing,
} from './cockpitMath.js';
import { greatCircleMeters } from './geoDistance.js';

/** Metres in one international nautical mile. */
export const METRES_PER_NM = 1852;

/** The radar's range steps in nautical miles, shortest first. */
export const RADAR_RANGES_NM = Object.freeze([3, 6, 12, 24]);

/** The range the radar opens on. */
export const DEFAULT_RADAR_RANGE_NM = 3;

/** At most this many contacts are drawn, nearest first. */
export const RADAR_MAX_CONTACTS = 60;

/** Range rings divide the range into this many equal steps. */
export const RADAR_RING_COUNT = 4;

/**
 * Normalize a range to one of the radar's steps.
 * @param {number} rangeNm Requested range in nautical miles.
 * @returns {number} The range when it is a step, else the default range.
 */
export function radarRangeNm(rangeNm) {
  return RADAR_RANGES_NM.includes(rangeNm) ? rangeNm : DEFAULT_RADAR_RANGE_NM;
}

/**
 * The range after this one; the longest range wraps to the shortest.
 * @param {number} rangeNm Current range in nautical miles.
 * @returns {number} The next range step.
 */
export function nextRadarRange(rangeNm) {
  const index = RADAR_RANGES_NM.indexOf(radarRangeNm(rangeNm));
  return RADAR_RANGES_NM[(index + 1) % RADAR_RANGES_NM.length];
}

/**
 * Range ring distances at each quarter of the range, innermost first.
 * @param {number} rangeNm Range in nautical miles.
 * @returns {number[]} Ring distances in nautical miles; the last is the range.
 */
export function radarRingsNm(rangeNm) {
  const range = radarRangeNm(rangeNm);
  return Array.from(
    { length: RADAR_RING_COUNT },
    (_, index) => (range * (index + 1)) / RADAR_RING_COUNT,
  );
}

/**
 * The search radius for a range, in metres.
 * @param {number} rangeNm Range in nautical miles.
 * @returns {number}
 */
export function radarRangeM(rangeNm) {
  return radarRangeNm(rangeNm) * METRES_PER_NM;
}

const round4 = (value) => Math.round(value * 1e4) / 1e4;

/**
 * Project vessel contacts onto a heading-up radar.
 *
 * Positions are fractions of the range circle: x to the right (starboard),
 * y up (ahead), both in [-1, 1]. Contacts outside the range, or without a
 * position, are left out; the rest come nearest first, at most `maxCount`.
 * @param {{latitude: number, longitude: number, headingDeg: number}} own
 *   Own ship position and the heading the radar is drawn up from.
 * @param {Array<{id: string, name?: string, latitude: number,
 *   longitude: number, course?: number|null, color?: string,
 *   stale?: boolean}>} contacts Nearby vessels.
 * @param {{rangeNm?: number, maxCount?: number}} [options]
 * @returns {Array<{id: string, name: string, x: number, y: number,
 *   distanceNm: number, relativeBearingDeg: number,
 *   relativeCourseDeg: number|null, color: string, stale: boolean}>}
 *   relativeBearingDeg and relativeCourseDeg are clockwise from the bow in
 *   [-180, 180).
 */
export function projectRadarContacts(own, contacts, options = {}) {
  const rangeNm = radarRangeNm(options.rangeNm ?? DEFAULT_RADAR_RANGE_NM);
  const cap =
    Number.isFinite(options.maxCount) && options.maxCount > 0
      ? Math.floor(options.maxCount)
      : RADAR_MAX_CONTACTS;
  const lat = Number(own?.latitude);
  const lon = Number(own?.longitude);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Array.isArray(contacts)
  )
    return [];
  const heading = normalizeHeading(own.headingDeg ?? 0);
  const projected = [];
  for (const contact of contacts) {
    const toLat = Number(contact?.latitude);
    const toLon = Number(contact?.longitude);
    const distanceNm =
      greatCircleMeters({ lat, lon }, { lat: toLat, lon: toLon }) /
      METRES_PER_NM;
    if (!Number.isFinite(distanceNm) || distanceNm > rangeNm) continue;
    const bearing = bearingBetweenCoordinates(lat, lon, toLat, toLon);
    const relativeBearingDeg =
      bearing === null ? 0 : relativeBearing(bearing, heading);
    const radians = (relativeBearingDeg * Math.PI) / 180;
    const fraction = distanceNm / rangeNm;
    const course =
      contact.course === null || contact.course === undefined
        ? NaN
        : Number(contact.course);
    projected.push({
      id: String(contact.id),
      name: String(contact.name || contact.id),
      x: round4(Math.sin(radians) * fraction),
      y: round4(Math.cos(radians) * fraction),
      distanceNm,
      relativeBearingDeg,
      relativeCourseDeg: Number.isFinite(course)
        ? relativeBearing(course, heading)
        : null,
      color: contact.color || '',
      stale: contact.stale === true,
    });
  }
  projected.sort((a, b) => a.distanceNm - b.distanceNm);
  return projected.slice(0, cap);
}

/**
 * The radar presentation without its worded labels.
 * @param {{latitude: number, longitude: number, headingDeg: number,
 *   courseDeg?: number|null}} own Own ship; `courseDeg` is course over ground.
 * @param {Array<object>} contacts See {@link projectRadarContacts}.
 * @param {number} rangeNm Range in nautical miles.
 * @returns {{rangeNm: number, ringsNm: number[], headingDeg: number,
 *   ownRelativeCourseDeg: number|null, contacts: Array<object>}}
 */
export function radarPicture(own, contacts, rangeNm) {
  const range = radarRangeNm(rangeNm);
  const headingDeg = normalizeHeading(own?.headingDeg ?? 0);
  const course =
    own?.courseDeg === null || own?.courseDeg === undefined
      ? NaN
      : Number(own.courseDeg);
  return {
    rangeNm: range,
    ringsNm: radarRingsNm(range),
    headingDeg,
    ownRelativeCourseDeg: Number.isFinite(course)
      ? relativeBearing(course, headingDeg)
      : null,
    contacts: projectRadarContacts({ ...own, headingDeg }, contacts, {
      rangeNm: range,
    }),
  };
}
