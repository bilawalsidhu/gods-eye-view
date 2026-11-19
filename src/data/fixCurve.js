/**
 * @module data/fixCurve
 * @description The path an aircraft is drawn along between two of its
 * reports, and the trail drawn behind it: a smooth curve that passes through
 * both reports and leaves each one along its reported track.
 *
 * The curve is a biarc: two constant-rate turns, each a renderer `arc`
 * motion segment (`render/contract/draw.d.ts`), joined where they share a
 * course. So the renderer draws exactly this curve, the app reads it back with
 * `render/motion/iconMotion`, and the trail samples the same segments: the
 * icon always sits on its own trail. Speed is constant between the two
 * reports, height changes evenly with time.
 *
 * The straight line between the reports is drawn instead (no curve) when
 * either report has no track, the pair is slower than 40 m/s (taxiing,
 * hovering, holding still), or a track points more than 75° off the line
 * between them: the reports do not describe one smooth turn.
 *
 * Each segment runs on for two seconds past its end along the same turn, so
 * when the next segment comes a little late the renderer keeps the icon moving
 * instead of holding it.
 */
import { eastNorthUp } from '../geo/frames.js';
import { motionCourse, motionPosition } from '../render/motion/iconMotion.js';
import { norm180, norm360 } from '../geo/vector.js';

/** @constant {number} Pairs slower than this (m/s) are joined straight. */
export const CURVE_MIN_SPEED_MPS = 40;
/** @constant {number} A track further than this (°) off the chord is joined straight. */
export const CURVE_MAX_TRACK_OFF_DEG = 75;
/** @constant {number} How long (s) a segment runs on past its end. */
export const CURVE_RUN_ON_S = 2;
/** @constant {number} Turn (°) between points a trail samples along a curve. */
export const CURVE_POINT_STEP_DEG = 1;

const DEG = Math.PI / 180;
/** Turn rates under this (rad/s) fly straight, as `iconMotion` draws them. */
const STRAIGHT_BELOW_RAD_PER_S = 1e-4;

function sinc(x) {
  return Math.abs(x) < 1e-4 ? 1 - (x * x) / 6 : Math.sin(x) / x;
}

const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/** A course (degrees) at `from`'s frame, read in `to`'s frame. */
function courseIn(courseDeg, fromFrame, toFrame) {
  const s = Math.sin(courseDeg * DEG);
  const c = Math.cos(courseDeg * DEG);
  const t = {
    x: s * fromFrame.x.x + c * fromFrame.y.x,
    y: s * fromFrame.x.y + c * fromFrame.y.y,
    z: s * fromFrame.x.z + c * fromFrame.y.z,
  };
  return Math.atan2(dot3(t, toFrame.x), dot3(t, toFrame.y)) / DEG;
}

/**
 * A constant-rate turn from `from` at `t0` setting off on `courseDeg`, that
 * reaches `to` at `t1` (epoch ms): an `arc` segment, straight when the turn
 * is too slow to draw as one.
 * @returns {{segment: object, endCourseDeg: number}}
 */
function arcThrough(from, frame, t0, t1, courseDeg, to) {
  const d = sub3(to, from);
  const e = dot3(d, frame.x);
  const n = dot3(d, frame.y);
  const u = dot3(d, frame.z);
  const seconds = (t1 - t0) / 1000;
  const chord = Math.hypot(e, n);
  const bearing = Math.atan2(e, n) / DEG;
  let turn = 2 * norm180(bearing - courseDeg);
  let track = courseDeg;
  if (Math.abs((turn * DEG) / seconds) < STRAIGHT_BELOW_RAD_PER_S) {
    turn = 0;
    track = bearing;
  }
  const length = chord / sinc((turn * DEG) / 2);
  return {
    segment: {
      kind: 'arc',
      fix: { x: from.x, y: from.y, z: from.z },
      t0,
      minDtS: 0,
      maxDtS: seconds + CURVE_RUN_ON_S,
      speedMps: length / seconds,
      trackDeg: norm360(track),
      turnRateDps: turn / seconds,
      climbMps: u / seconds,
    },
    endCourseDeg: track + turn,
  };
}

/**
 * A straight `arc` segment from `from` at `t0` that reaches `to` at `t1`
 * (epoch ms) and runs on past it for CURVE_RUN_ON_S.
 */
export function straightSegment(from, t0, t1, to) {
  const frame = eastNorthUp(from);
  const d = sub3(to, from);
  const bearing = Math.atan2(dot3(d, frame.x), dot3(d, frame.y)) / DEG;
  return arcThrough(from, frame, t0, t1, bearing, to).segment;
}

/**
 * The curve between two reports, or null to join them straight.
 * @param {{x: number, y: number, z: number}} fromPos The earlier report (ECEF).
 * @param {number} fromMs Its time, epoch ms.
 * @param {number} fromTrackDeg Its reported track.
 * @param {{x: number, y: number, z: number}} toPos The later report.
 * @param {number} toMs
 * @param {number} toTrackDeg
 * @returns {{pieces: Array<{segment: object, t0: number, t1: number}>}|null}
 *   One or two pieces in time order, together running from `fromMs` to
 *   `toMs`; each `segment` is a contract `arc` motion segment.
 */
export function fixCurve(
  fromPos,
  fromMs,
  fromTrackDeg,
  toPos,
  toMs,
  toTrackDeg,
) {
  if (!Number.isFinite(fromTrackDeg) || !Number.isFinite(toTrackDeg))
    return null;
  if (!(toMs > fromMs) || !fromPos || !toPos) return null;
  const seconds = (toMs - fromMs) / 1000;
  const frame = eastNorthUp(fromPos);
  const d = sub3(toPos, fromPos);
  const e = dot3(d, frame.x);
  const n = dot3(d, frame.y);
  const u = dot3(d, frame.z);
  const chord = Math.hypot(e, n);
  if (!(chord / seconds >= CURVE_MIN_SPEED_MPS)) return null;
  const toFrame = eastNorthUp(toPos);
  const startDeg = fromTrackDeg;
  // The later report's track, read in the earlier report's frame.
  const endDeg = courseIn(toTrackDeg, toFrame, frame);
  const bearing = Math.atan2(e, n) / DEG;
  if (
    Math.abs(norm180(startDeg - bearing)) > CURVE_MAX_TRACK_OFF_DEG ||
    Math.abs(norm180(endDeg - bearing)) > CURVE_MAX_TRACK_OFF_DEG
  )
    return null;

  // The biarc's join with equal tangent lengths: p0 = 0, p1 = (e, n),
  // unit tangents t0 and t1.
  const t0x = Math.sin(startDeg * DEG);
  const t0y = Math.cos(startDeg * DEG);
  const t1x = Math.sin(endDeg * DEG);
  const t1y = Math.cos(endDeg * DEG);
  const vv = e * e + n * n;
  const vt = e * (t0x + t1x) + n * (t0y + t1y);
  const tt = t0x * t1x + t0y * t1y;
  const denom = 2 * (1 - tt);
  const reach =
    denom < 1e-9
      ? vv / (4 * (e * t1x + n * t1y))
      : (-vt + Math.sqrt(vt * vt + denom * vv)) / denom;
  if (!(reach > 0) || !Number.isFinite(reach)) return null;
  const jx = (reach * t0x + e - reach * t1x) / 2;
  const jy = (reach * t0y + n - reach * t1y) / 2;

  // Each arc's length from its chord and turn, to share the time by.
  const arcLength = (cx, cy, courseDeg) => {
    const c = Math.hypot(cx, cy);
    const turn = 2 * norm180(Math.atan2(cx, cy) / DEG - courseDeg);
    return { length: c / sinc((turn * DEG) / 2), turn };
  };
  const first = arcLength(jx, jy, startDeg);
  const second = arcLength(e - jx, n - jy, startDeg + first.turn);
  const total = first.length + second.length;
  if (!(total > 0)) return null;
  // One arc where a piece would be under a metre.
  if (first.length < 1 || second.length < 1) {
    const only = arcThrough(fromPos, frame, fromMs, toMs, startDeg, toPos);
    return { pieces: [{ segment: only.segment, t0: fromMs, t1: toMs }] };
  }
  const joinMs = fromMs + (toMs - fromMs) * (first.length / total);
  const share = first.length / total;
  const join = {
    x: fromPos.x + frame.x.x * jx + frame.y.x * jy + frame.z.x * u * share,
    y: fromPos.y + frame.x.y * jx + frame.y.y * jy + frame.z.y * u * share,
    z: fromPos.z + frame.x.z * jx + frame.y.z * jy + frame.z.z * u * share,
  };
  const a = arcThrough(fromPos, frame, fromMs, joinMs, startDeg, join);
  // The second arc starts exactly where the first is drawn to end.
  const joined = motionPosition(a.segment, null, joinMs);
  const joinFrame = eastNorthUp(joined);
  const b = arcThrough(
    joined,
    joinFrame,
    joinMs,
    toMs,
    courseIn(a.endCourseDeg, frame, joinFrame),
    toPos,
  );
  return {
    pieces: [
      { segment: a.segment, t0: fromMs, t1: joinMs },
      { segment: b.segment, t0: joinMs, t1: toMs },
    ],
  };
}

const cache = new WeakMap();

/**
 * `fixCurve` for two report objects that keep their position object, kept
 * per earlier report's position until either report changes.
 */
export function fixCurveCached(
  fromPos,
  fromMs,
  fromTrackDeg,
  toPos,
  toMs,
  toTrackDeg,
) {
  if (!fromPos || typeof fromPos !== 'object') return null;
  const hit = cache.get(fromPos);
  if (
    hit &&
    hit.toPos === toPos &&
    hit.fromMs === fromMs &&
    hit.toMs === toMs &&
    hit.fromTrackDeg === fromTrackDeg &&
    hit.toTrackDeg === toTrackDeg &&
    hit.fx === fromPos.x &&
    hit.fy === fromPos.y &&
    hit.fz === fromPos.z &&
    hit.tx === toPos.x &&
    hit.ty === toPos.y &&
    hit.tz === toPos.z
  )
    return hit.curve;
  const curve = fixCurve(
    fromPos,
    fromMs,
    fromTrackDeg,
    toPos,
    toMs,
    toTrackDeg,
  );
  cache.set(fromPos, {
    toPos,
    fromMs,
    toMs,
    fromTrackDeg,
    toTrackDeg,
    fx: fromPos.x,
    fy: fromPos.y,
    fz: fromPos.z,
    tx: toPos?.x,
    ty: toPos?.y,
    tz: toPos?.z,
    curve,
  });
  return curve;
}

/** The piece of `curve` drawn at `tMs` (the last one past its end). */
export function curvePieceAt(curve, tMs) {
  const pieces = curve.pieces;
  for (let i = 0; i < pieces.length - 1; i++)
    if (tMs < pieces[i].t1) return pieces[i];
  return pieces[pieces.length - 1];
}

/** Where the curve puts the aircraft at `tMs`, and its course. */
export function curvePositionAt(curve, tMs) {
  const piece = curvePieceAt(curve, tMs);
  const t = Math.min(tMs, piece.t1);
  return {
    position: motionPosition(piece.segment, null, t),
    courseDeg: motionCourse(piece.segment, undefined, t),
  };
}

/**
 * Points along the curve from `fromMs` to `toMs` (exclusive of both ends),
 * one at least every CURVE_POINT_STEP_DEG of turn, so the line drawn
 * through them stays within a couple of metres of the curve.
 * @returns {Array<{x: number, y: number, z: number}>}
 */
export function curvePoints(curve, fromMs, toMs) {
  const out = [];
  for (const piece of curve.pieces) {
    const start = Math.max(fromMs, piece.t0);
    const end = Math.min(toMs, piece.t1);
    if (!(end > start)) continue;
    const seconds = (end - start) / 1000;
    const turned = Math.abs(piece.segment.turnRateDps * seconds);
    const steps = Math.max(1, Math.ceil(turned / CURVE_POINT_STEP_DEG));
    // The piece's start, unless it is the curve's own start.
    if (start > fromMs) out.push(motionPosition(piece.segment, null, start));
    for (let k = 1; k < steps; k++)
      out.push(
        motionPosition(
          piece.segment,
          null,
          start + ((end - start) * k) / steps,
        ),
      );
  }
  return out;
}
