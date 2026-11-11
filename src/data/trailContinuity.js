/**
 * @module trailContinuity
 * @description Where a tracked aircraft's trail lifts the pen.
 *
 * A trail is a chronological list of fixes `{position, timeMs, nullAltitude,
 * breakBefore, drawn}`: reports, and (`drawn`) points where the tracked icon
 * was drawn between them. Between two consecutive fixes that are not one path, a new
 * segment starts and nothing is drawn between them: no dashes, no arcs.
 * Nothing is dropped except the oldest fixes past the layer's point limit.
 *
 * Two points are not one path when time does not advance, when the gap is
 * longer than 48 minutes (a coverage hole or a separate flight), when the
 * implied great-circle speed is over 1,500 kt, or when either point has no
 * reported altitude. A parked aircraft is the exception: a pair under three
 * hours apart within 0.1 nm stays one path.
 *
 * Civil and military flight tracking share these rules.
 */
import * as Cesium from 'cesium';

/** @constant {number} A gap longer than this is a coverage hole or a separate flight. */
export const TRAIL_CONTINUITY_MAX_GAP_MS = 48 * 60_000;

/** @constant {number} A pair implying more than this great-circle speed is not one path. */
export const TRAIL_CONTINUITY_MAX_SPEED_KT = 1_500;

/** @constant {number} A parked aircraft may stop reporting this long and stay one path. */
export const TRAIL_STATIONARY_HOLD_MAX_GAP_MS = 3 * 60 * 60_000;

/** @constant {number} How close (nautical miles) two points must be to count as parked. */
export const TRAIL_STATIONARY_HOLD_MAX_DISTANCE_NM = 0.1;

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
 * @param {Cesium.Cartesian3} a
 * @param {Cesium.Cartesian3} b
 * @returns {number}
 */
export function trailDistanceM(a, b) {
  return Cesium.Cartesian3.angleBetween(a, b) * EARTH_MEAN_RADIUS_M;
}

/**
 * Whether the pen lifts between two consecutive fixes.
 * @param {object|undefined} prev - Earlier fix, if any.
 * @param {object} next - Later fix.
 * @returns {boolean}
 */
export function trailFixBreaks(prev, next) {
  if (!prev || prev.nullAltitude || next.nullAltitude) return true;
  // A recorded point is where the icon was drawn; the speed between it and a
  // report it was eased onto is not a flight speed, so only the gap counts.
  if (prev.drawn || next.drawn)
    return Math.abs(next.timeMs - prev.timeMs) > TRAIL_CONTINUITY_MAX_GAP_MS;
  return trailPairBreaks(
    next.timeMs - prev.timeMs,
    trailDistanceM(prev.position, next.position),
  );
}

/**
 * Build backfill fixes from chronological waypoints. Every waypoint with a
 * position is kept. A waypoint without one (no altitude and no known ground)
 * is skipped, and the line still breaks there.
 * @param {{position: Cesium.Cartesian3|null, timeMs: number, nullAltitude: boolean}[]} waypoints
 * @returns {{fixes: object[], breakAfter: boolean}} The fixes, and whether the
 *   line breaks after the last one because trailing waypoints were skipped.
 */
export function trailBackfillFixes(waypoints) {
  const fixes = [];
  let skipped = false;
  for (const { position, timeMs, nullAltitude } of waypoints) {
    if (!position) {
      skipped = true;
      continue;
    }
    const fix = { position, timeMs, nullAltitude: !!nullAltitude };
    fix.breakBefore = skipped || trailFixBreaks(fixes[fixes.length - 1], fix);
    skipped = false;
    fixes.push(fix);
  }
  return { fixes, breakAfter: skipped };
}

/**
 * Put backfill fixes ahead of the live trail. The join follows the same
 * rule, so a distant history tail never connects to the first live fix.
 * Past `maxPoints` the oldest recorded points go first, then the oldest
 * reports.
 * @param {{fixes: object[], breakAfter: boolean}} backfill
 * @param {object[]} live - Live fixes; the first one's break is recomputed.
 * @param {number} maxPoints - Point limit across all segments.
 * @returns {object[]} The joined trail.
 */
export function joinTrailBackfill({ fixes, breakAfter }, live, maxPoints) {
  if (!fixes.length) return live;
  if (live.length)
    live[0].breakBefore =
      breakAfter || trailFixBreaks(fixes[fixes.length - 1], live[0]);
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
 * Leave out the newest recorded points that lie inside the aircraft's 3D
 * model, so the body never runs through the fuselage; the head then runs
 * from the newest point outside the model to the plane. Reports are kept.
 * @param {object[]} fixes
 * @param {number} count - From `trailBodyCount`.
 * @param {Cesium.Cartesian3|null} modelCenter - The model's centre, or null
 *   when no model is the visual.
 * @param {number|null} envelopeM - The model's radius (m).
 * @returns {number}
 */
export function trailBodyCountOutsideModel(
  fixes,
  count,
  modelCenter,
  envelopeM,
) {
  if (!modelCenter || !(envelopeM > 0)) return count;
  while (
    count > 0 &&
    fixes[count - 1].drawn &&
    Cesium.Cartesian3.distance(fixes[count - 1].position, modelCenter) <
      envelopeM
  )
    count -= 1;
  return count;
}

/**
 * The drawn trail body, split at breaks: the first `count` fixes.
 * @param {object[]} fixes
 * @param {number} count - From `trailBodyCount`.
 * @returns {Cesium.Cartesian3[][]}
 */
export function trailBodySegments(fixes, count) {
  const segments = [];
  for (let i = 0; i < count; i++) {
    const fix = fixes[i];
    // A live report with no altitude keeps no position; it only breaks the line.
    if (!fix.position) continue;
    if (fix.breakBefore || !segments.length) segments.push([]);
    segments[segments.length - 1].push(fix.position);
  }
  return segments;
}

/**
 * Draw body segments. A trail without breaks support draws only the newest
 * segment, never a line across a break.
 * @param {{setSegments?: Function, setPositions: Function}} trail
 * @param {Cesium.Cartesian3[][]} segments
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
 * @param {Cesium.Cartesian3} head - Displayed aircraft position.
 * @param {number} nowMs - Current time.
 * @param {number} count - Body fixes, from `trailBodyCount`.
 * @returns {object|null}
 */
export function trailHeadStartFix(fixes, head, nowMs, count) {
  if (count < 1 || !head) return null;
  const last = fixes[count - 1];
  if (!last.position) return null;
  if (Cesium.Cartesian3.distance(last.position, head) < TRAIL_HEAD_MIN_M)
    return null;
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
  return fix?.time ? Cesium.JulianDate.toDate(fix.time).getTime() : NaN;
}

/** @constant {number} The tracked icon's drawn position is recorded at least this often (ms of display time)... */
export const TRAIL_RECORD_STEP_MS = 1_000;

/** @constant {number} ...or whenever it has moved this far (m), whichever comes first. */
export const TRAIL_RECORD_STEP_M = 150;

/** @constant {number} A recorded point is kept only where dropping it would move the line by more than this (m) across the track or in height. */
export const TRAIL_THIN_TOLERANCE_M = 30;

/** @constant {number} A recorded point is kept where dropping it would leave a straight piece longer than this (m), so a long leg still has vertices. */
export const TRAIL_THIN_MAX_SPAN_M = 10_000;

/** @constant {number} A kept point stands in for at most this many dropped positions; past it the point is kept. */
const TRAIL_THIN_MAX_ABSORBED = 512;

/** @constant {number} A recorded point is dropped where the line turns back sharper than this (degrees)... */
export const TRAIL_SPUR_TURN_DEG = 120;

/** @constant {number} ...over a step shorter than this (m). */
export const TRAIL_SPUR_MAX_STEP_M = 500;

/** @constant {number} A recorded point closer than this (m) to the previous one is not kept: the aircraft is holding. */
const TRAIL_RECORD_MIN_STEP_M = 1;

const _u = new Cesium.Cartesian3();
const _v = new Cesium.Cartesian3();

/** Cosine of the turn at `b` on the way a → b → c, or NaN for a zero step. */
function turnCos(a, b, c) {
  Cesium.Cartesian3.subtract(b, a, _u);
  Cesium.Cartesian3.subtract(c, b, _v);
  const lu = Cesium.Cartesian3.magnitude(_u);
  const lv = Cesium.Cartesian3.magnitude(_v);
  if (!(lu > 0 && lv > 0)) return NaN;
  return Cesium.Cartesian3.dot(_u, _v) / (lu * lv);
}

const SPUR_COS = Math.cos(Cesium.Math.toRadians(TRAIL_SPUR_TURN_DEG));

/** Whether entry `i` and its neighbours are one drawn piece of line. */
function joinedAt(fixes, i) {
  const a = fixes[i - 1];
  const b = fixes[i];
  const c = fixes[i + 1];
  return (
    a?.position &&
    b?.position &&
    c?.position &&
    !b.breakBefore &&
    !c.breakBefore
  );
}

/** Whether the line turns back on itself at entry `i` over a short step. */
function spurAt(fixes, i) {
  if (!joinedAt(fixes, i)) return false;
  const a = fixes[i - 1].position;
  const b = fixes[i].position;
  const c = fixes[i + 1].position;
  if (
    Math.min(
      Cesium.Cartesian3.distance(a, b),
      Cesium.Cartesian3.distance(b, c),
    ) > TRAIL_SPUR_MAX_STEP_M
  )
    return false;
  return turnCos(a, b, c) < SPUR_COS;
}

/** Remove entry `i` and re-judge the break before the entry that takes its place. */
function removeAt(fixes, i) {
  fixes.splice(i, 1);
  if (i < fixes.length)
    fixes[i].breakBefore = trailFixBreaks(fixes[i - 1], fixes[i]);
}

/**
 * Keep the point limit: drop the oldest recorded point first, and the oldest
 * report only when no recorded point is left.
 * @param {object[]} fixes - The trail, mutated.
 * @param {number} maxPoints
 * @returns {object[]} `fixes`.
 */
function keepTrailLimit(fixes, maxPoints) {
  let excess = fixes.length - maxPoints;
  if (excess <= 0) return fixes;
  for (let i = 0; i < fixes.length && excess > 0;) {
    if (fixes[i].drawn) {
      removeAt(fixes, i);
      excess -= 1;
    } else i += 1;
  }
  if (excess > 0) fixes.splice(0, excess);
  return fixes;
}

const _ab = new Cesium.Cartesian3();
const _ap = new Cesium.Cartesian3();
const _off = new Cesium.Cartesian3();
const _up = new Cesium.Cartesian3();

/** Whether `p` lies within the thinning tolerance of segment a → b, across the track and in height. */
function nearSegment(p, a, b) {
  Cesium.Cartesian3.subtract(b, a, _ab);
  Cesium.Cartesian3.subtract(p, a, _ap);
  const len2 = Cesium.Cartesian3.magnitudeSquared(_ab);
  const t =
    len2 > 0
      ? Math.max(0, Math.min(1, Cesium.Cartesian3.dot(_ap, _ab) / len2))
      : 0;
  Cesium.Cartesian3.multiplyByScalar(_ab, t, _off);
  Cesium.Cartesian3.subtract(_ap, _off, _off);
  Cesium.Cartesian3.normalize(p, _up);
  const vertical = Cesium.Cartesian3.dot(_off, _up);
  const across = Math.sqrt(
    Math.max(0, Cesium.Cartesian3.magnitudeSquared(_off) - vertical * vertical),
  );
  return (
    Math.abs(vertical) <= TRAIL_THIN_TOLERANCE_M &&
    across <= TRAIL_THIN_TOLERANCE_M
  );
}

/**
 * Drop recorded point `i` when the line without it stays within the
 * tolerance of every position it stood for, and the straight piece left is
 * no longer than TRAIL_THIN_MAX_SPAN_M. The positions it stood for go on to
 * the next entry. Reports are never dropped.
 * @returns {boolean} Whether it was dropped.
 */
function thinAt(fixes, i) {
  const entry = fixes[i];
  if (!entry?.drawn || entry.sealed || !joinedAt(fixes, i)) return false;
  const a = fixes[i - 1].position;
  const next = fixes[i + 1];
  if (next.sealed) return false;
  const b = next.position;
  if (Cesium.Cartesian3.distance(a, b) > TRAIL_THIN_MAX_SPAN_M) return false;
  const stood = entry.absorbed ?? [];
  const nextStood = next.absorbed ?? [];
  if (stood.length + nextStood.length + 1 > TRAIL_THIN_MAX_ABSORBED)
    return false;
  if (!nearSegment(entry.position, a, b)) return false;
  for (const p of stood) if (!nearSegment(p.position, a, b)) return false;
  for (const p of nextStood) if (!nearSegment(p.position, a, b)) return false;
  next.absorbed = stood.concat(
    [{ position: entry.position, timeMs: entry.timeMs }],
    nextStood,
  );
  removeAt(fixes, i);
  return true;
}

/**
 * Thin the recorded points either side of entry `i`, reaching past a
 * neighbouring report: the point recorded just before a report is only
 * judged once the line goes on beyond it.
 */
function thinAround(fixes, i) {
  if (!thinAt(fixes, i + 1) && fixes[i + 1] && !fixes[i + 1].drawn)
    thinAt(fixes, i + 2);
  if (thinAt(fixes, i - 1)) i -= 1;
  else if (fixes[i - 1] && !fixes[i - 1].drawn) thinAt(fixes, i - 2);
}

/**
 * Drop recorded points that make a spur next to entry `i`. Reports are never
 * dropped; at a report the recorded neighbour is dropped instead.
 * @returns {number} The index entry `i` ends up at.
 */
function removeSpursAround(fixes, i) {
  for (let guard = 0; guard < 64; guard++) {
    let changed = false;
    for (const j of [i - 1, i, i + 1]) {
      if (!spurAt(fixes, j)) continue;
      let drop = -1;
      if (fixes[j].drawn) drop = j;
      else if (fixes[j + 1]?.drawn) drop = j + 1;
      else if (fixes[j - 1]?.drawn) drop = j - 1;
      if (drop < 0) continue;
      removeAt(fixes, drop);
      if (drop < i) i -= 1;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return i;
}

/** Index a fix at `timeMs` goes in at: after every entry at or before it. */
function insertionIndex(fixes, timeMs) {
  let i = fixes.length;
  while (i > 0 && fixes[i - 1].timeMs > timeMs) i -= 1;
  return i;
}

/**
 * Insert an entry at `i`, judge both breaks, remove spurs, thin the recorded
 * points either side and keep the limit.
 */
function insertAt(fixes, i, entry, maxPoints) {
  fixes.splice(i, 0, entry);
  entry.breakBefore = trailFixBreaks(fixes[i - 1], entry);
  const after = fixes[i + 1];
  if (after) {
    after.breakBefore = trailFixBreaks(entry, after);
    // Positions the next entry stood for that come before this one are now
    // on this entry's side.
    if (after.absorbed?.length) {
      const mine = after.absorbed.filter((p) => p.timeMs < entry.timeMs);
      if (mine.length) {
        entry.absorbed = mine;
        after.absorbed = after.absorbed.filter((p) => p.timeMs >= entry.timeMs);
      }
    }
  }
  i = removeSpursAround(fixes, i);
  thinAround(fixes, i);
  keepTrailLimit(fixes, maxPoints);
}

/** Index of the newest report before entry `i`, or -1. */
function reportBefore(fixes, i) {
  let j = i - 1;
  while (j >= 0 && fixes[j].drawn) j -= 1;
  return j;
}

/** Index of the oldest report at or after `i`, or `fixes.length`. */
function reportFrom(fixes, i) {
  let j = i;
  while (j < fixes.length && fixes[j].drawn) j += 1;
  return j;
}

/**
 * Put a report into the trail in time order. Reports are the record: they
 * are kept as anchors among the recorded points.
 *
 * - A report the display has already passed replaces the guess drawn after
 *   it: the recorded points timed after it go, and nothing is recorded until
 *   the icon has eased onto the correction (`displayMs` + `settleMs`), so the
 *   line reads arc, report, corrected path.
 * - Recorded points never join two reports that break under
 *   `trailPairBreaks` (too long or too fast apart to be one flight): the
 *   points between them go and the line breaks.
 * - A live report with no altitude keeps no position and only breaks the
 *   line.
 * @param {object[]} fixes - The trail, mutated.
 * @param {Cesium.Cartesian3} position - Owned position.
 * @param {number} timeMs - The report's epoch ms.
 * @param {number} maxPoints - Point limit across all segments.
 * @param {{nullAltitude?: boolean, displayMs?: number, settleMs?: number}} [options]
 *   `displayMs`: the time the aircraft is drawn at as the report arrives;
 *   `settleMs`: how long the icon takes to ease onto a correction.
 * @returns {object[]} `fixes`.
 */
export function insertTrailFix(
  fixes,
  position,
  timeMs,
  maxPoints,
  { nullAltitude = false, displayMs = NaN, settleMs = 0 } = {},
) {
  const entry = {
    position: nullAltitude ? null : position,
    timeMs,
    nullAltitude,
    drawn: false,
    breakBefore: false,
  };
  let i = insertionIndex(fixes, timeMs);
  // The guess drawn after a report the display already passed.
  fixes.splice(i, reportFrom(fixes, i) - i);
  if (displayMs > timeMs) entry.settleUntilMs = displayMs + settleMs;
  // Recorded points across a pair of reports that are not one flight.
  const before = reportBefore(fixes, i);
  if (before >= 0 && trailFixBreaks(fixes[before], entry)) {
    fixes.splice(before + 1, i - before - 1);
    i = before + 1;
  }
  insertAt(fixes, i, entry, maxPoints);
  return fixes;
}

/**
 * Record where the tracked aircraft was drawn at a display time. Between
 * reports this recorded path is the trail, so the line follows every turn
 * the icon made instead of a straight chord between two reports. Points are
 * thinned by shape: one stays only where dropping it would move the line by
 * more than TRAIL_THIN_TOLERANCE_M across the track or in height, or leave a
 * straight piece longer than TRAIL_THIN_MAX_SPAN_M. Nothing is recorded
 * while the aircraft holds.
 * @param {object[]} fixes - The trail, mutated.
 * @param {Cesium.Cartesian3} position - Owned drawn position.
 * @param {number} timeMs - Display time it was drawn for.
 * @param {number} maxPoints - Point limit across all segments.
 * @returns {boolean} Whether the trail changed.
 */
export function recordTrailPoint(fixes, position, timeMs, maxPoints) {
  const i = insertionIndex(fixes, timeMs);
  const prev = fixes[i - 1];
  if (
    prev?.position &&
    Cesium.Cartesian3.distance(prev.position, position) <
      TRAIL_RECORD_MIN_STEP_M
  )
    return false;
  const entry = {
    position,
    timeMs,
    nullAltitude: false,
    drawn: true,
    breakBefore: false,
  };
  insertAt(fixes, i, entry, maxPoints);
  // Entries before the second report behind this point can never be thinned
  // again, so they let go of the positions they stood for.
  const passed = reportBefore(fixes, fixes.lastIndexOf(entry));
  if (passed >= 0) sealThrough(fixes, reportBefore(fixes, passed));
  return true;
}

/** Release the absorbed positions of entry `i` and everything before it. */
function sealThrough(fixes, i) {
  for (let j = i; j >= 0 && !fixes[j].sealed; j--) {
    fixes[j].sealed = true;
    delete fixes[j].absorbed;
  }
}

/**
 * Whether the icon's drawn position must not be recorded at a display time:
 * a report on either side of it has no altitude (the icon is drawn at an
 * invented height), the reports on either side are not one flight
 * (`trailPairBreaks`), or the icon is still easing onto a report that
 * arrived after the display had passed it.
 * @param {object[]} fixes
 * @param {number} displayMs
 * @returns {boolean}
 */
export function trailRecordingBlocked(fixes, displayMs) {
  const i = insertionIndex(fixes, displayMs);
  const before = fixes[reportBefore(fixes, i)];
  const after = fixes[reportFrom(fixes, i)];
  if (before?.nullAltitude || after?.nullAltitude) return true;
  if (before?.settleUntilMs > displayMs) return true;
  return !!(before && after && trailFixBreaks(before, after));
}
