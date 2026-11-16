import { fromDegrees } from '../geo/ellipsoid.js';
import {
  julianFromEpochMs,
  julianLessThan,
  julianLessThanOrEquals,
  julianToEpochMs,
  secondsDifference,
} from '../geo/julian.js';
import { clone, distance } from '../geo/vector.js';
import { curvePieceAt, fixCurveCached } from './fixCurve.js';
import { historyBracketIndex, historyUnseenAt } from './timelineHistory.js';
import {
  COAST_MAX_SPEED_MPS,
  courseBetweenCartesians,
  speedRamp,
  STALE_COAST_MAX_SEC,
  staleCoastLimitSeconds,
  staleHoldsForFix,
} from './motionModel.js';

/**
 * Which record fields carry an aircraft layer's reported ground speed (m/s)
 * and track (degrees clockwise from north).
 * @typedef {{speed: string, track: string}} AircraftRecordFields
 */

/** A fix's own ground speed, else the record's; never over COAST_MAX_SPEED_MPS. */
export function fixSpeedMps(fix, info, fields) {
  return Math.min(
    Number.isFinite(fix.velocity)
      ? fix.velocity
      : (info && info[fields.speed]) || 0,
    COAST_MAX_SPEED_MPS,
  );
}

/** A fix's own track, else the record's. */
export function fixTrackDeg(fix, info, fields) {
  return Number.isFinite(fix.track)
    ? fix.track
    : (info && info[fields.track]) || 0;
}

/**
 * The instant `epochMs` as a Julian date (into `result` when given), for
 * `aircraftMotionRegime`'s `renderTime`.
 */
export function julianAt(epochMs, result) {
  return julianFromEpochMs(epochMs, result);
}

/** A history fix's time in epoch ms: its `epochMs`, else its `time`'s. */
export function fixEpochMs(fix) {
  return Number.isFinite(fix.epochMs) ? fix.epochMs : julianToEpochMs(fix.time);
}

/** A feed fix's ECEF position, from its degrees and render altitude. */
export function fixPosition(lonDeg, latDeg, heightM) {
  return fromDegrees(lonDeg, latDeg, heightM);
}

/** A copy of a fix position, for a trail that keeps it. */
export function copyPosition(position) {
  return clone(position);
}

/**
 * A position-history entry for a feed fix at `epochMs`, carrying the fix's
 * own speed and track; it keeps a copy of `position`.
 */
export function historyFix(epochMs, position, velocity, track) {
  return {
    time: julianAt(epochMs),
    epochMs,
    position: clone(position),
    velocity,
    track,
  };
}

/**
 * Whether a history fix is a forward synthetic fix (a motion aid built from
 * a repeated report's new speed or course, `synthesizeForwardKinematicsFix`)
 * rather than a report.
 */
export const isSyntheticFix = (fix) => Number.isFinite(fix?.reportEpochMs);

/**
 * Put a new report at the end of a contact's history: forward synthetic
 * fixes after the previous report go (the report supersedes them), and past
 * `limit` the oldest fixes go.
 * @param {Array<object>} history Oldest first; mutated.
 * @param {object} fix The report's history fix.
 * @param {number} limit
 */
export function pushReport(history, fix, limit) {
  while (history.length && isSyntheticFix(history[history.length - 1]))
    history.pop();
  history.push(fix);
  while (history.length > limit) history.shift();
}

/** The newest report in a history (not a synthetic fix), or undefined. */
export function newestReport(history) {
  for (let i = history.length - 1; i >= 0; i--)
    if (!isSyntheticFix(history[i])) return history[i];
  return undefined;
}

/** The curve a contact is drawn along between two history fixes, or null. */
export function historyCurve(a, b) {
  return fixCurveCached(
    a.position,
    fixEpochMs(a),
    a.track,
    b.position,
    fixEpochMs(b),
    b.track,
  );
}

/** A reusable result for `aircraftMotionRegime`. */
export function createMotionRegime() {
  return {
    kind: 'fix',
    a: null,
    b: null,
    piece: null,
    span: 0,
    speed: 0,
    trackFrom: 0,
    trackTo: 0,
    chordCourse: null,
    blend: 0,
    fix: null,
    heading: 0,
    turnRateDps: 0,
    minDt: 0,
    maxDt: 0,
    unseen: false,
  };
}

/**
 * Which motion an aircraft's history gives at `renderTime` — the one choice
 * the CPU dead reckoning and the icon planner (GPU segment) both draw from.
 *
 * - `between`: between the bracketing pair `a`→`b`, no extrapolation
 *   error and no snap-back. Along their curve (`data/fixCurve`) when the
 *   pair describes one: `piece` is the curve's piece at `renderTime`, a
 *   contract `arc` segment with its times. Otherwise straight from `a` to
 *   `b` (`piece` null), and the course of the DISPLAYED motion blends the
 *   time-interpolated reported track toward the chord by `blend`: the chord
 *   is only trustworthy when the segment covers real ground (at hover its
 *   direction is GPS jitter; on a slow tight turn it STEPS the whole
 *   per-segment turn at each boundary), and helicopters never use it
 *   (rotorcraft chords are noise-dominated at their typical speeds).
 * - `fix`: extrapolate `fix` by the elapsed time clamped to [minDt, maxDt].
 *   Warm-up (renderTime predates ALL history: freshly seen or just tracked,
 *   before a poll interval of history exists) runs the OLDEST fix BACKWARD,
 *   preserving the behind-real-time invariant, so as history fills the icon
 *   glides FORWARD into interpolation with no freeze and no backward snap
 *   (holding the oldest fix froze the icon; extrapolating the newest to
 *   wall-clock made it jump back a poll interval when interpolation took
 *   over). Otherwise the newest fix coasts on its last speed and heading for
 *   five minutes past it, then stops (SIGNAL LOST). A contact last heard on
 *   or near the ground holds there instead (`staleHoldsForFix`, decided once
 *   per report), and a chain of synthetic fixes never coasts further than
 *   the real report they were built from would. Following the clock, a
 *   warm-up well before a contact's own first fix is `unseen`: it was not
 *   there yet, and is not drawn (`historyUnseenAt`).
 *
 * @param {Array<object>} history Non-empty, oldest first.
 * @param {object|undefined} info The contact's record.
 * @param {{dayNumber: number, secondsOfDay: number}} renderTime A Julian date (geo/julian).
 * @param {AircraftRecordFields} fields
 * @param {object} result From `createMotionRegime`; returned filled in.
 * @param {{cachedGroundFloor?: (latDeg: number, lonDeg: number) => number|null}} [options]
 *   The ground under a report, where known, for the hold decision.
 */
export function aircraftMotionRegime(
  history,
  info,
  renderTime,
  fields,
  result,
  { cachedGroundFloor } = {},
) {
  // A synthetic fix a later report superseded is not on the path: the
  // contact is drawn report to report, as its trail is.
  let report = history.length - 1;
  while (report >= 0 && isSyntheticFix(history[report])) report--;
  // The pairs are read back from the fix after the first one at or after
  // the render time (so a fix at exactly that time takes the later pair, as
  // it always did; past any superseded synthetic fix there), found by
  // halving, and stop at the first pair wholly before it: a contact
  // following the clock keeps a long history.
  let start = Math.min(
    historyBracketIndex(history, renderTime) + 1,
    history.length - 1,
  );
  while (start < report && isSyntheticFix(history[start])) start++;
  let b = null;
  for (let i = start; i >= 0; i--) {
    const a = history[i];
    if (i < report && isSyntheticFix(a)) continue;
    const pairB = b;
    b = a;
    if (!pairB) continue;
    if (julianLessThan(pairB.time, renderTime)) break;
    if (
      !julianLessThanOrEquals(a.time, renderTime) ||
      !julianLessThanOrEquals(renderTime, pairB.time)
    )
      continue;
    const span = secondsDifference(pairB.time, a.time);
    const chordLenM = distance(a.position, pairB.position);
    const speed =
      span > 0 ? chordLenM / span : (info && info[fields.speed]) || 0;
    const fallbackTrack = (info && info[fields.track]) || 0;
    const trackFrom = Number.isFinite(a.track) ? a.track : fallbackTrack;
    const blend = info && info.klass === 'helicopter' ? 0 : speedRamp(speed);
    const curve = span > 0 ? historyCurve(a, pairB) : null;
    result.kind = 'between';
    result.a = a;
    result.b = pairB;
    result.piece = curve
      ? curvePieceAt(curve, julianToEpochMs(renderTime))
      : null;
    result.span = span;
    result.speed = speed;
    result.trackFrom = trackFrom;
    result.trackTo = Number.isFinite(pairB.track) ? pairB.track : trackFrom;
    result.chordCourse =
      blend > 0 ? courseBetweenCartesians(a.position, pairB.position) : null;
    result.blend = blend;
    result.unseen = false;
    return result;
  }
  const newest = history[history.length - 1];
  const warming = julianLessThan(renderTime, history[0].time);
  result.kind = 'fix';
  result.piece = null;
  result.fix = warming ? history[0] : newest;
  result.unseen = warming && historyUnseenAt(history, renderTime);
  result.speed = fixSpeedMps(result.fix, info, fields);
  result.heading = fixTrackDeg(result.fix, info, fields);
  // Past the newest report it flies straight on along its course: a turn
  // rate averaged over earlier reports outlives the turn it measured, and
  // coasting on it put contacts kilometres off a straight path.
  result.turnRateDps = 0;
  result.minDt = -60;
  // A warm-up ends when real time reaches the oldest fix; a single fix keeps
  // coasting forward on the same line.
  result.maxDt =
    warming && history.length > 1
      ? 0
      : staleCoastSeconds(newest, info, cachedGroundFloor);
  return result;
}

/**
 * How long `newest` coasts at most: five minutes, less what a synthetic
 * fix's chain already coasted since its real report (`reportEpochMs`); none
 * for a report that holds (judged once per report, from its ground flag and
 * the ground under it where `cachedGroundFloor` knows it).
 * @param {object} newest
 * @param {object|undefined} info
 * @param {Function} [cachedGroundFloor]
 * @returns {number}
 */
export function staleCoastSeconds(newest, info, cachedGroundFloor) {
  const newestMs = fixEpochMs(newest);
  const limitSec = staleCoastLimitSeconds({
    fixEpochMs: newestMs,
    lastContactEpochMs: info?.lastContactEpochMs,
    // A plane that stops reporting keeps flying for five minutes, whatever
    // its contact time, then stops dimmed as SIGNAL LOST. A missed update
    // shows STALE throughout.
    minimumSec: 300,
    maximumSec: 300,
  });
  if (staleHoldsForFix(newest, { onGround: info?.onGround, cachedGroundFloor }))
    return 0;
  const alreadySec = Number.isFinite(newest.reportEpochMs)
    ? Math.max(0, (newestMs - newest.reportEpochMs) / 1000)
    : 0;
  return Math.max(0, Math.min(limitSec, STALE_COAST_MAX_SEC - alreadySec));
}

/** A raw position this far (m) off its own path, plus half its step, is a jump. */
const RAW_JUMP_SLACK_M = 5;

/**
 * Whether a tracked aircraft's raw position jumped this frame: a new report
 * moved its path. Judged against the path itself, where its last frame's
 * step carries it, not against a reported speed (which can be stale or 0
 * while the drawn motion, minutes behind the newest report, is fast). A
 * frame with no step to go by (the first on a track, or the one after a
 * jump) is never a jump.
 * @param {{x: number, y: number, z: number}} raw This frame's raw position.
 * @param {{x: number, y: number, z: number}} prevRaw Last frame's.
 * @param {{x: number, y: number, z: number}} prevRawStep Last frame's step.
 * @param {number} prevRawStepSec Last frame's length, s (0: no step).
 * @param {number} dtSec This frame's length, s.
 * @returns {boolean}
 */
export function rawPositionJumped(
  raw,
  prevRaw,
  prevRawStep,
  prevRawStepSec,
  dtSec,
) {
  if (!(prevRawStepSec > 0)) return false;
  const k = dtSec / prevRawStepSec;
  const dx = raw.x - (prevRaw.x + prevRawStep.x * k);
  const dy = raw.y - (prevRaw.y + prevRawStep.y * k);
  const dz = raw.z - (prevRaw.z + prevRawStep.z * k);
  const stepM =
    Math.hypot(prevRawStep.x, prevRawStep.y, prevRawStep.z) * Math.abs(k);
  return Math.hypot(dx, dy, dz) > RAW_JUMP_SLACK_M + 0.5 * stepM;
}

/**
 * How fast the drawn path moves (m/s), from its last raw step; `fallback`
 * (a reported speed) with no step to go by.
 * @param {{x: number, y: number, z: number}} step
 * @param {number} stepSec
 * @param {number} fallback
 * @returns {number}
 */
export function rawStepSpeedMps(step, stepSec, fallback) {
  if (!(stepSec > 0)) return fallback;
  return Math.hypot(step.x, step.y, step.z) / stepSec;
}
