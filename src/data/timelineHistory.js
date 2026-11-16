import {
  fromDegrees,
  fromRadians,
  toCartographicRadians,
} from '../geo/ellipsoid.js';
import {
  julianFromEpochMs,
  julianLessThan,
  secondsDifference,
} from '../geo/julian.js';
import { clone, copyInto, toDegrees, toRadians } from '../geo/vector.js';
import {
  mergeTimelineRuns,
  readTimelineFixes,
  TIMELINE_UNSEEN_MS,
} from '../time/timelineFixes.js';

/** Fixes nearer than this are too close to read a course between. */
const COURSE_MIN_M = 5;
const EARTH_RADIUS_M = 6_371_000;

/** The initial great-circle course from one fix to another (degrees from
 * north), or null when they are too close to tell. */
function courseBetween(from, to) {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLon = toRadians(to.lon - from.lon);
  const dLat = lat2 - lat1;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  if (2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a))) < COURSE_MIN_M)
    return null;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/**
 * An aircraft's motion history with the fixes its record carries at a time
 * (`observation.fixes`, see src/time/timelineFixes.js) merged in, so the
 * layer places it on its own track at any time they span; null when the
 * record carries none. Each fix is drawn at the record's render height,
 * moved by the fix's own barometric change from the record's, and heads
 * where its track goes next (the last, where it came from). Entries are
 * marked `timeline`.
 * @param {object[]|undefined} history The contact's history entries.
 * @param {object} observation The record, with `fixes` and `baroAltitudeM`.
 * @param {{renderAltitudeM: number, renderAltitudeInvented?: boolean}} meta
 * @param {number|null} velocity The record's ground speed (m/s).
 * @param {number} centreMs The snapshot's time: the fixes kept are nearest it.
 * @returns {object[]|null}
 */
export function mergeAircraftTimelineFixes(
  history,
  observation,
  meta,
  velocity,
  centreMs,
) {
  const fixes = readTimelineFixes(observation?.fixes);
  if (!fixes) return null;
  const baroM = Number.isFinite(observation.baroAltitudeM)
    ? observation.baroAltitudeM
    : null;
  const entries = fixes.map((fix, index) => {
    const course =
      index + 1 < fixes.length
        ? courseBetween(fix, fixes[index + 1])
        : courseBetween(fixes[index - 1], fix);
    return {
      time: julianFromEpochMs(fix.atMs),
      epochMs: fix.atMs,
      position: fromDegrees(
        fix.lon,
        fix.lat,
        baroM !== null && fix.altitudeM !== null
          ? meta.renderAltitudeM + (fix.altitudeM - baroM)
          : meta.renderAltitudeM,
      ),
      velocity,
      // No reported track per fix: the course is read from the fixes.
      track: course ?? undefined,
      inventedHeight: meta.renderAltitudeInvented === true,
      timeline: true,
    };
  });
  return mergeTimelineRuns(
    history ?? [],
    entries,
    (entry) => entry.epochMs,
    centreMs,
  );
}

/**
 * The index of the first history entry at or after `renderTime` (the last
 * entry when none is), by halving: a contact following the clock keeps up to
 * TIMELINE_FIXES_LIMIT entries, and it is placed on every fleet tick. The
 * bracketing pair is the entry before it and it.
 * @param {Array<{time: {dayNumber: number, secondsOfDay: number}}>} history
 *   In time order (Julian dates, geo/julian).
 * @param {{dayNumber: number, secondsOfDay: number}} renderTime
 * @returns {number}
 */
export function historyBracketIndex(history, renderTime) {
  let low = 0;
  let high = history.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (julianLessThan(history[mid].time, renderTime)) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Whether a contact following the clock is not to be drawn at `renderTime`:
 * its history is its own fixes around the time (`timeline` entries), and the
 * time is more than TIMELINE_UNSEEN_MS before the first, when it was not
 * there yet.
 * @param {Array<{time: {dayNumber: number, secondsOfDay: number},
 *   timeline?: boolean}>|undefined} history
 * @param {{dayNumber: number, secondsOfDay: number}} renderTime
 * @returns {boolean}
 */
export function historyUnseenAt(history, renderTime) {
  const first = history?.[0];
  return (
    first?.timeline === true &&
    secondsDifference(first.time, renderTime) > TIMELINE_UNSEEN_MS / 1000
  );
}

/**
 * Lift a grounded contact's history onto the floor: its newest fix to
 * `position`, or, when the history is its own fixes around the time
 * (`timeline` entries, the newest of them later than the time drawn), every
 * fix by the lift from `fromM` to `toM`, so it is not drawn rising to it.
 * @param {object[]|undefined} history
 * @param {{x: number, y: number, z: number}} position The newest fix lifted (ECEF).
 * @param {number|null} fromM The height it was drawn at.
 * @param {number} toM The height it is lifted to.
 */
export function liftGroundedHistory(history, position, fromM, toM) {
  const newest = history?.[history.length - 1];
  if (!newest) return;
  if (history[0].timeline !== true || !Number.isFinite(fromM)) {
    newest.position = newest.position
      ? copyInto(position, newest.position)
      : clone(position);
    return;
  }
  for (const entry of history) {
    const carto = toCartographicRadians(entry.position);
    if (!carto) continue;
    copyInto(
      fromRadians(carto.lon, carto.lat, carto.height + (toM - fromM)),
      entry.position,
    );
  }
}

/**
 * The history entries a tracked contact's trail has yet to take: those after
 * its newest point (`trail` entries have `timeMs`) up to `untilMs`, the
 * snapshot's time, so the trail grows as the snapshots bring fixes.
 * @param {Array<{epochMs: number}>} history
 * @param {Array<{timeMs: number}>} trail
 * @param {number} untilMs
 * @returns {object[]}
 */
export function historyAfterTrail(history, trail, untilMs) {
  const lastMs = trail.length ? trail[trail.length - 1].timeMs : -Infinity;
  return history.filter(
    (entry) => entry.epochMs > lastMs && entry.epochMs <= untilMs,
  );
}
