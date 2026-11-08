import { fromDegrees } from '../geo/ellipsoid.js';
import {
  julianFromEpochMs,
  julianLessThan,
  julianLessThanOrEquals,
  julianToEpochMs,
  secondsDifference,
} from '../geo/julian.js';
import { clone, distance } from '../geo/vector.js';
import {
  courseBetweenCartesians,
  speedRamp,
  staleCoastLimitSeconds,
} from './motionModel.js';

/**
 * Which record fields carry an aircraft layer's reported ground speed (m/s)
 * and track (degrees clockwise from north).
 * @typedef {{speed: string, track: string}} AircraftRecordFields
 */

/** A fix's own ground speed, else the record's. */
export function fixSpeedMps(fix, info, fields) {
  return Number.isFinite(fix.velocity)
    ? fix.velocity
    : (info && info[fields.speed]) || 0;
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

/** A reusable result for `aircraftMotionRegime`. */
export function createMotionRegime() {
  return {
    kind: 'fix',
    a: null,
    b: null,
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
  };
}

/**
 * Which motion an aircraft's history gives at `renderTime` — the one choice
 * the CPU dead reckoning and the icon planner (GPU segment) both draw from.
 *
 * - `between`: interpolate the bracketing pair `a`→`b`, no extrapolation
 *   error and no snap-back. The course of the DISPLAYED motion blends the
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
 *   over). Otherwise the newest fix coasts. A feed can still be receiving
 *   fresh contact messages for that aircraft; freezing 60 s after the
 *   position produced a stop → catch-up → stop cadence, so it coasts through
 *   the latest real contact plus a bounded grace, with an absolute cap so a
 *   stale cached feed cannot drift forever.
 *
 * @param {Array<object>} history Non-empty, oldest first.
 * @param {object|undefined} info The contact's record.
 * @param {{dayNumber: number, secondsOfDay: number}} renderTime A Julian date (geo/julian).
 * @param {AircraftRecordFields} fields
 * @param {object} result From `createMotionRegime`; returned filled in.
 */
export function aircraftMotionRegime(
  history,
  info,
  renderTime,
  fields,
  result,
) {
  for (let i = history.length - 1; i >= 1; i--) {
    const a = history[i - 1];
    const b = history[i];
    if (
      !julianLessThanOrEquals(a.time, renderTime) ||
      !julianLessThanOrEquals(renderTime, b.time)
    )
      continue;
    const span = secondsDifference(b.time, a.time);
    const chordLenM = distance(a.position, b.position);
    const speed =
      span > 0 ? chordLenM / span : (info && info[fields.speed]) || 0;
    const fallbackTrack = (info && info[fields.track]) || 0;
    const trackFrom = Number.isFinite(a.track) ? a.track : fallbackTrack;
    const blend = info && info.klass === 'helicopter' ? 0 : speedRamp(speed);
    result.kind = 'between';
    result.a = a;
    result.b = b;
    result.span = span;
    result.speed = speed;
    result.trackFrom = trackFrom;
    result.trackTo = Number.isFinite(b.track) ? b.track : trackFrom;
    result.chordCourse =
      blend > 0 ? courseBetweenCartesians(a.position, b.position) : null;
    result.blend = blend;
    return result;
  }
  const newest = history[history.length - 1];
  const warming = julianLessThan(renderTime, history[0].time);
  result.kind = 'fix';
  result.fix = warming ? history[0] : newest;
  result.speed = fixSpeedMps(result.fix, info, fields);
  result.heading = fixTrackDeg(result.fix, info, fields);
  result.turnRateDps = (info && info.turnRateDps) || 0;
  result.minDt = -60;
  // A warm-up ends when real time reaches the oldest fix; a single fix keeps
  // coasting forward on the same arc.
  result.maxDt =
    warming && history.length > 1
      ? 0
      : staleCoastLimitSeconds({
          // `epochMs` is captured once when the poll is normalized. Avoid
          // allocating a Date per aircraft on every 12 Hz fleet tick.
          fixEpochMs: Number.isFinite(newest.epochMs)
            ? newest.epochMs
            : julianToEpochMs(newest.time),
          lastContactEpochMs: info?.lastContactEpochMs,
          // Permit one minute of contact grace but cap any cached-feed drift
          // at five minutes. Source backoff is exposed separately as a STALE cue.
          minimumSec: 60,
          maximumSec: 300,
        });
  return result;
}
