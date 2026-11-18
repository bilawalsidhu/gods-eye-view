/**
 * @module trailContinuity
 * @description A tracked aircraft's trail, and where it lifts the pen.
 *
 * A trail is a chronological list of reports `{position, timeMs, track,
 * nullAltitude, breakBefore}`. Between two consecutive reports that are one
 * path, the line follows the curve the aircraft is drawn along between them
 * (`data/fixCurve`), so the icon always sits on its own trail and no guess
 * about where it went between reports is ever kept: a late report can never
 * leave a kink. Between two that are not one path, a new segment starts and
 * nothing is drawn between them: no dashes, no arcs. Nothing is dropped
 * except the oldest reports past the layer's point limit.
 *
 * Two points are not one path when time does not advance, when the gap is
 * longer than 48 minutes (a coverage hole or a separate flight), when the
 * implied great-circle speed is over 1,500 kt, or when either point has no
 * reported altitude. A parked aircraft is the exception: a pair under three
 * hours apart within 0.1 nm stays one path. A history backfill that ends in
 * the air does not join an aircraft now on the ground (or the reverse) when
 * more than five minutes lie between them: the landing or take-off was not
 * seen, and is often a different flight.
 *
 * Civil and military flight tracking share these rules.
 */
import { julianToEpochMs } from '../geo/julian.js';
import { cross, distance, dot, magnitude, normalize } from '../geo/vector.js';
import { curvePoints, fixCurveCached } from './fixCurve.js';

/** @constant {number} A gap longer than this is a coverage hole or a separate flight. */
export const TRAIL_CONTINUITY_MAX_GAP_MS = 48 * 60_000;

/** @constant {number} A pair implying more than this great-circle speed is not one path. */
export const TRAIL_CONTINUITY_MAX_SPEED_KT = 1_500;

/** @constant {number} A parked aircraft may stop reporting this long and stay one path. */
export const TRAIL_STATIONARY_HOLD_MAX_GAP_MS = 3 * 60 * 60_000;

/** @constant {number} How close (nautical miles) two points must be to count as parked. */
export const TRAIL_STATIONARY_HOLD_MAX_DISTANCE_NM = 0.1;

/**
 * @constant {number} An airborne point and a ground point more than this far
 *   apart in time do not join: the landing or take-off between them was not
 *   seen. A last waypoint on short final is a few minutes from the runway.
 */
export const TRAIL_UNSEEN_TRANSITION_MAX_GAP_MS = 5 * 60_000;

/** @constant {number} The head never joins a body point farther than this from the aircraft. */
export const TRAIL_HEAD_JOIN_MAX_M = 150_000;

const METRES_PER_NM = 1852;

/** @constant {number} Mean Earth radius (m) for great-circle trail distances. */
const EARTH_MEAN_RADIUS_M = 6_371_008.8;

/**
 * Whether two consecutive trail points belong to different paths. Time that
 * does not advance, a gap over TRAIL_CONTINUITY_MAX_GAP_MS or an implied
 * speed over TRAIL_CONTINUITY_MAX_SPEED_KT breaks the line, except for a
 * parked aircraft: a pair under three hours apart within 0.1 nm.
 * @param {number} deltaMs - Later point's time minus the earlier one's.
 * @param {number} distanceM - Great-circle distance between the points.
 * @returns {boolean}
 */
export function trailPairBreaks(deltaMs, distanceM) {
  if (!(deltaMs > 0) || !Number.isFinite(distanceM)) return true;
  const distanceNm = distanceM / METRES_PER_NM;
  if (
    deltaMs <= TRAIL_STATIONARY_HOLD_MAX_GAP_MS &&
    distanceNm <= TRAIL_STATIONARY_HOLD_MAX_DISTANCE_NM
  )
    return false;
  return (
    deltaMs > TRAIL_CONTINUITY_MAX_GAP_MS ||
    distanceNm / (deltaMs / 3_600_000) > TRAIL_CONTINUITY_MAX_SPEED_KT
  );
}

/**
 * Whether the head segment may join the last body point to the aircraft:
 * within TRAIL_HEAD_JOIN_MAX_M and not broken under `trailPairBreaks`.
 * @param {number} deltaMs - Current time minus the body point's time.
 * @param {number} distanceM - Distance from the body point to the aircraft.
 * @returns {boolean}
 */
export function trailHeadJoins(deltaMs, distanceM) {
  return (
    distanceM <= TRAIL_HEAD_JOIN_MAX_M && !trailPairBreaks(deltaMs, distanceM)
  );
}

/**
 * Great-circle distance between two trail positions, in metres.
 * @param {{x: number, y: number, z: number}} a
 * @param {{x: number, y: number, z: number}} b
 * @returns {number}
 */
export function trailDistanceM(a, b) {
  const unitA = normalize(a);
  const unitB = normalize(b);
  const angle = Math.atan2(magnitude(cross(unitA, unitB)), dot(unitA, unitB));
  return angle * EARTH_MEAN_RADIUS_M;
}

/**
 * Whether the pen lifts between two consecutive fixes.
 * @param {object|undefined} prev - Earlier fix, if any.
 * @param {object} next - Later fix.
 * @returns {boolean}
 */
export function trailFixBreaks(prev, next) {
  if (!prev || prev.nullAltitude || next.nullAltitude) return true;
  return trailPairBreaks(
    next.timeMs - prev.timeMs,
    trailDistanceM(prev.position, next.position),
  );
}

/**
 * Build backfill fixes from chronological waypoints. Every waypoint with a
 * position is kept. A waypoint without one (no altitude and no known ground)
 * is skipped, and the line still breaks there.
 * @param {{position: {x: number, y: number, z: number}|null, timeMs: number, nullAltitude: boolean, track?: number}[]} waypoints
 * @returns {{fixes: object[], breakAfter: boolean}} The fixes, and whether the
 *   line breaks after the last one because trailing waypoints were skipped.
 */
export function trailBackfillFixes(waypoints) {
  const fixes = [];
  let skipped = false;
  for (const { position, timeMs, nullAltitude, track } of waypoints) {
    if (!position) {
      skipped = true;
      continue;
    }
    const fix = { position, timeMs, nullAltitude: !!nullAltitude };
    if (Number.isFinite(track)) fix.track = track;
    fix.breakBefore = skipped || trailFixBreaks(fixes[fixes.length - 1], fix);
    skipped = false;
    fixes.push(fix);
  }
  return { fixes, breakAfter: skipped };
}

/**
 * Whether the line from an airborne point to a ground point (in either
 * order) skips a landing or take-off that was not seen.
 * @param {boolean} prevOnGround - Whether the earlier point is on the ground.
 * @param {boolean} nextOnGround - Whether the later point is on the ground.
 * @param {number} deltaMs - Later point's time minus the earlier one's.
 * @returns {boolean}
 */
export function trailGroundTransitionBreaks(
  prevOnGround,
  nextOnGround,
  deltaMs,
) {
  return (
    prevOnGround !== nextOnGround &&
    !(deltaMs <= TRAIL_UNSEEN_TRANSITION_MAX_GAP_MS)
  );
}

/**
 * Put backfill fixes ahead of the live trail. The join follows the same
 * rule, so a distant history tail never connects to the first live fix.
 * A backfill whose last waypoint is in the air while the first live report
 * is on the ground (or the reverse), more than five minutes before it, does
 * not join it either. A live report that does not say uses the aircraft's
 * state now; with no live fix to start after it, the backfill is checked
 * against now and left out, so the head never draws that line. Past `maxPoints` the oldest
 * reports go.
 * @param {{fixes: object[], breakAfter: boolean}} backfill
 * @param {object[]} live - Live fixes; the first one's break is recomputed.
 * @param {number} maxPoints - Point limit across all segments.
 * @param {object} [ground] - Ground state across the join.
 * @param {boolean} [ground.backfillEndsOnGround] - The last waypoint's.
 * @param {boolean} [ground.onGroundNow] - The aircraft's now, for a live
 *   report that does not carry its own `onGround`.
 * @param {number} [ground.nowMs] - Time the aircraft is at now.
 * @returns {object[]} The joined trail.
 */
export function joinTrailBackfill(
  { fixes, breakAfter },
  live,
  maxPoints,
  ground = null,
) {
  if (!fixes.length) return live;
  const last = fixes[fixes.length - 1];
  const unseen = (laterMs, laterOnGround) =>
    ground !== null &&
    typeof ground.backfillEndsOnGround === 'boolean' &&
    typeof laterOnGround === 'boolean' &&
    trailGroundTransitionBreaks(
      ground.backfillEndsOnGround,
      laterOnGround,
      laterMs - last.timeMs,
    );
  if (!live.length)
    return Number.isFinite(ground?.nowMs) &&
      unseen(ground.nowMs, ground.onGroundNow)
      ? live
      : keepTrailLimit(fixes, maxPoints);
  const first = live[0];
  live[0].breakBefore =
    breakAfter ||
    trailFixBreaks(last, first) ||
    unseen(
      first.timeMs,
      typeof first.onGround === 'boolean'
        ? first.onGround
        : ground?.onGroundNow,
    );
  return keepTrailLimit(fixes.concat(live), maxPoints);
}

/**
 * How many fixes the drawn body holds: every fix at or before the display
 * time, where the aircraft is drawn. Fixes ahead of it (reports newer than
 * the delayed display) are reached by the head segment instead, so the trail
 * never runs past the aircraft, and once the display passes the newest
 * report the body ends there.
 * @param {object[]} fixes
 * @param {number} displayMs - Time the aircraft is drawn at.
 * @returns {number}
 */
export function trailBodyCount(fixes, displayMs) {
  let count = fixes.length;
  while (count > 0 && fixes[count - 1].timeMs > displayMs) count -= 1;
  return count;
}

/**
 * The drawn trail body, split at breaks: the first `count` reports, each
 * pair that is one path joined along its curve (`data/fixCurve`).
 * @param {object[]} fixes
 * @param {number} count - From `trailBodyCount`.
 * @returns {{x: number, y: number, z: number}[][]}
 */
export function trailBodySegments(fixes, count) {
  const segments = [];
  let prev = null;
  for (let i = 0; i < count; i++) {
    const fix = fixes[i];
    // A live report with no altitude keeps no position; it only breaks the line.
    if (!fix.position) {
      prev = null;
      continue;
    }
    if (fix.breakBefore || !segments.length || !prev) segments.push([]);
    else {
      const curve = trailPairCurve(prev, fix);
      if (curve)
        segments[segments.length - 1].push(
          ...curvePoints(curve, prev.timeMs, fix.timeMs),
        );
    }
    segments[segments.length - 1].push(fix.position);
    prev = fix;
  }
  return segments;
}

/** The curve between two consecutive trail reports, or null for a straight line. */
export function trailPairCurve(prev, next) {
  return fixCurveCached(
    prev.position,
    prev.timeMs,
    prev.track,
    next.position,
    next.timeMs,
    next.track,
  );
}

/**
 * The points of the live head between the last body report and the time the
 * aircraft is drawn: along the curve to the next report, which the aircraft
 * is on its way to, when that pair is one path; none otherwise (the head is
 * then a straight line to the aircraft).
 * @param {object[]} fixes
 * @param {number} count - Body reports, from `trailBodyCount`.
 * @param {number} displayMs - Time the aircraft is drawn at.
 * @returns {{x: number, y: number, z: number}[]}
 */
export function trailHeadCurvePoints(fixes, count, displayMs) {
  const last = fixes[count - 1];
  const next = fixes[count];
  if (!last?.position || !next?.position || next.breakBefore) return [];
  const curve = trailPairCurve(last, next);
  if (!curve) return [];
  // Exclusive of the display time: the point there is the aircraft's own.
  return curvePoints(curve, last.timeMs, displayMs);
}

/** @constant {number} How far back from the newest report `trailTimeAt` looks for the aircraft (ms). */
export const TRAIL_TIME_AT_SEARCH_MS = 15 * 60_000;

/**
 * The time on the trail at which `position` lies: the pair of consecutive
 * reports, one path, whose straight line passes closest to it (the newest
 * pair when two are as close), and the time that far along between them.
 * Past the newest report the time runs on at that pair's pace; before the
 * oldest pair it runs back the same way. Only pairs ending within
 * TRAIL_TIME_AT_SEARCH_MS of the newest report are looked at, so a loop
 * flown earlier is not mistaken for where the aircraft is now.
 *
 * This is how the trail finds the time an aircraft placed by someone else
 * (a host-supplied placement) is drawn at: whatever delay that placement
 * draws with, the trail then ends where the aircraft is drawn.
 * @param {object[]} fixes - The trail, chronological.
 * @param {{x: number, y: number, z: number}|null|undefined} position - Where the aircraft is drawn.
 * @returns {number} Epoch ms; NaN when no pair of reports is one path.
 */
export function trailTimeAt(fixes, position) {
  if (!position || fixes.length < 2) return NaN;
  const newestMs = fixes[fixes.length - 1].timeMs;
  let bestM = Infinity;
  let bestMs = NaN;
  for (let i = fixes.length - 1; i > 0; i--) {
    const b = fixes[i];
    if (newestMs - b.timeMs > TRAIL_TIME_AT_SEARCH_MS) break;
    const a = fixes[i - 1];
    if (!a.position || !b.position || b.breakBefore) continue;
    const spanMs = b.timeMs - a.timeMs;
    if (!(spanMs > 0)) continue;
    const dx = b.position.x - a.position.x;
    const dy = b.position.y - a.position.y;
    const dz = b.position.z - a.position.z;
    const lengthSq = dx * dx + dy * dy + dz * dz;
    let u =
      lengthSq > 0
        ? ((position.x - a.position.x) * dx +
            (position.y - a.position.y) * dy +
            (position.z - a.position.z) * dz) /
          lengthSq
        : 0;
    // Only the newest pair runs on past its end, only the oldest looked at
    // back past its start; the rest are their own segment.
    const newest = i === fixes.length - 1;
    const oldest =
      i === 1 || newestMs - fixes[i - 1].timeMs > TRAIL_TIME_AT_SEARCH_MS;
    const along = Math.min(Math.max(u, 0), 1);
    const offM = Math.hypot(
      position.x - (a.position.x + along * dx),
      position.y - (a.position.y + along * dy),
      position.z - (a.position.z + along * dz),
    );
    if (!(offM < bestM)) continue;
    if (!(u > 1 && newest)) u = Math.min(u, 1);
    if (!(u < 0 && oldest)) u = Math.max(u, 0);
    bestM = offM;
    bestMs = a.timeMs + u * spanMs;
  }
  return bestMs;
}

/**
 * Draw body segments. A trail without breaks support draws only the newest
 * segment, never a line across a break.
 * @param {{setSegments?: Function, setPositions: Function}} trail
 * @param {{x: number, y: number, z: number}[][]} segments
 */
export function drawTrailSegments(trail, segments) {
  if (typeof trail.setSegments === 'function') trail.setSegments(segments);
  else trail.setPositions(segments[segments.length - 1] ?? []);
}

/** @constant {number} A head shorter than this (m) is not drawn: the aircraft is holding at its last report. */
const TRAIL_HEAD_MIN_M = 0.5;

/**
 * The body fix the head segment starts from, or null when the head is not
 * drawn: no body yet, the aircraft holding at that fix, a body point more
 * than 150 km from the aircraft, or one too long ago or too far away to be
 * one path.
 * @param {object[]} fixes
 * @param {{x: number, y: number, z: number}} head - Displayed aircraft position.
 * @param {number} nowMs - Current time.
 * @param {number} count - Body fixes, from `trailBodyCount`.
 * @returns {object|null}
 */
export function trailHeadStartFix(fixes, head, nowMs, count) {
  if (count < 1 || !head) return null;
  const last = fixes[count - 1];
  if (!last.position) return null;
  if (distance(last.position, head) < TRAIL_HEAD_MIN_M) return null;
  return trailHeadJoins(
    nowMs - last.timeMs,
    trailDistanceM(last.position, head),
  )
    ? last
    : null;
}

/**
 * Epoch ms of a position-history fix (`{epochMs?, time}`).
 * @param {object|undefined} fix
 * @returns {number} NaN when unknown.
 */
export function historyFixEpochMs(fix) {
  if (Number.isFinite(fix?.epochMs)) return fix.epochMs;
  return fix?.time ? julianToEpochMs(fix.time) : NaN;
}

/** Keep the point limit: the oldest reports go first. */
function keepTrailLimit(fixes, maxPoints) {
  const excess = fixes.length - maxPoints;
  if (excess > 0) fixes.splice(0, excess);
  return fixes;
}

/** Index a fix at `timeMs` goes in at: after every entry at or before it. */
function insertionIndex(fixes, timeMs) {
  let i = fixes.length;
  while (i > 0 && fixes[i - 1].timeMs > timeMs) i -= 1;
  return i;
}

/**
 * Put a report into the trail in time order and judge the breaks on both
 * sides of it. A live report with no altitude keeps no position and only
 * breaks the line.
 * @param {object[]} fixes - The trail, mutated.
 * @param {{x: number, y: number, z: number}} position - Owned position.
 * @param {number} timeMs - The report's epoch ms.
 * @param {number} maxPoints - Point limit across all segments.
 * @param {{nullAltitude?: boolean, onGround?: boolean, track?: number}} [options]
 *   `onGround`: whether the report was on the ground, when known;
 *   `track`: its reported track, which the curve leaves it along.
 * @returns {object[]} `fixes`.
 */
export function insertTrailFix(
  fixes,
  position,
  timeMs,
  maxPoints,
  { nullAltitude = false, onGround = undefined, track = undefined } = {},
) {
  const entry = {
    position: nullAltitude ? null : position,
    timeMs,
    nullAltitude,
    breakBefore: false,
  };
  if (Number.isFinite(track)) entry.track = track;
  // Whether the report was on the ground, when known: a history backfill
  // joins it only across a landing or take-off it saw.
  if (typeof onGround === 'boolean') entry.onGround = onGround;
  const i = insertionIndex(fixes, timeMs);
  fixes.splice(i, 0, entry);
  entry.breakBefore = trailFixBreaks(fixes[i - 1], entry);
  const after = fixes[i + 1];
  if (after) after.breakBefore = trailFixBreaks(entry, after);
  keepTrailLimit(fixes, maxPoints);
  return fixes;
}
