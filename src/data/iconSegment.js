/**
 * @module iconSegment
 * @description The motion an icon row follows between CPU updates: one segment, packed
 * into a row of floats that the CPU ({@link evaluateSegment}) and the GPU
 * ({@link ICON_SEGMENT_GLSL}) evaluate the same way at a render time.
 *
 * A segment is `position(τ) = base + U·e(τ) + V·n(τ)` plus a course:
 * - hold: stays at `base`, course fixed;
 * - lerp: straight from `base` to `base + U` between two fix times (the interpolation
 *   between two known fixes), course affine in the fraction;
 * - arc: a constant-rate turn from a fix in its east/north plane (`U`, `V`), with the
 *   elapsed time clamped (warm-up before the first fix, coast after the last).
 *
 * The arc uses `cos a − cos(a+b) = 2 sin(b/2) sin(a+b/2)`, so its offset is
 * `v·t·sinc(ωt/2)·(sin, cos)(a + ωt/2)`: no cancellation in float32 and no branch
 * between straight and turning motion. Turn rates under 1e-4 rad/s fly straight,
 * as `arcOffsetEnu` does.
 *
 * Times are seconds since the owning set's epoch. `base` is stored as high and low
 * float32 parts (Cesium's EncodedCartesian3) so the GPU can draw it relative to the eye.
 */
import * as Cesium from 'cesium';
import { norm180, norm360 } from './motionModel.js';

/** Floats per packed segment. */
export const SEGMENT_STRIDE = 24;

export const SEGMENT_HOLD = 0;
export const SEGMENT_LERP = 1;
export const SEGMENT_ARC = 2;

// Offsets inside one packed segment. The GPU reads them as six vec4s in this order.
const BASE_HIGH = 0;
const BASE_LOW = 3;
const AXIS_U = 6;
const AXIS_V = 9;
const KIND = 12;
const T0 = 13;
const P1 = 14; // lerp: span (s); arc: smallest elapsed time (s)
const P2 = 15; // arc: largest elapsed time (s)
const SPEED = 16; // m/s
const TRACK = 17; // rad, clockwise from north
const OMEGA = 18; // rad/s
const COURSE0 = 19; // deg
const COURSE_SLOPE = 20; // lerp: deg per unit fraction
const SLEW_OFFSET = 21; // deg still to glide at SLEW_T0
const SLEW_T0 = 22; // s
const SLEW_RATE = 23; // deg/s; negative holds the course at the glide's start

const DEG = Math.PI / 180;
const STRAIGHT_BELOW_RAD_PER_SEC = 1e-4;

const _encoded = new Cesium.EncodedCartesian3();
const _enu = new Cesium.Matrix4();

function writeBase(out, o, position) {
  Cesium.EncodedCartesian3.fromCartesian(position, _encoded);
  out[o + BASE_HIGH] = _encoded.high.x;
  out[o + BASE_HIGH + 1] = _encoded.high.y;
  out[o + BASE_HIGH + 2] = _encoded.high.z;
  out[o + BASE_LOW] = _encoded.low.x;
  out[o + BASE_LOW + 1] = _encoded.low.y;
  out[o + BASE_LOW + 2] = _encoded.low.z;
}

function clearMotion(out, o) {
  out.fill(0, o + AXIS_U, o + SEGMENT_STRIDE);
}

/**
 * Stay at `position` facing `courseDeg`.
 * @param {Float32Array} out
 * @param {number} row
 * @param {Cesium.Cartesian3} position
 * @param {number} courseDeg
 */
export function writeHoldSegment(out, row, position, courseDeg) {
  const o = row * SEGMENT_STRIDE;
  writeBase(out, o, position);
  clearMotion(out, o);
  out[o + KIND] = SEGMENT_HOLD;
  out[o + COURSE0] = norm360(courseDeg || 0);
}

/**
 * Move straight from `from` (at `t0`) to `to` (at `t1`), holding at either end.
 * The course runs from `course0Deg` by `courseSlopeDeg` over the segment.
 * @param {Float32Array} out
 * @param {number} row
 * @param {{from: Cesium.Cartesian3, to: Cesium.Cartesian3, t0: number, t1: number,
 *   course0Deg: number, courseSlopeDeg: number}} segment
 */
export function writeLerpSegment(out, row, segment) {
  const o = row * SEGMENT_STRIDE;
  const { from, to } = segment;
  writeBase(out, o, from);
  clearMotion(out, o);
  out[o + AXIS_U] = to.x - from.x;
  out[o + AXIS_U + 1] = to.y - from.y;
  out[o + AXIS_U + 2] = to.z - from.z;
  out[o + KIND] = SEGMENT_LERP;
  out[o + T0] = segment.t0;
  out[o + P1] = Math.max(0, segment.t1 - segment.t0);
  out[o + COURSE0] = norm360(segment.course0Deg || 0);
  out[o + COURSE_SLOPE] = segment.courseSlopeDeg || 0;
}

/**
 * Turn at a constant rate from `fix` (at `t0`) in its east/north plane, with the
 * elapsed time clamped to `[minDt, maxDt]`.
 * @param {Float32Array} out
 * @param {number} row
 * @param {{fix: Cesium.Cartesian3, t0: number, minDt: number, maxDt: number,
 *   speedMps: number, trackDeg: number, turnRateDps: number}} segment
 */
export function writeArcSegment(out, row, segment) {
  const o = row * SEGMENT_STRIDE;
  const { fix } = segment;
  writeBase(out, o, fix);
  clearMotion(out, o);
  Cesium.Transforms.eastNorthUpToFixedFrame(fix, Cesium.Ellipsoid.WGS84, _enu);
  // Column-major: columns 0 and 1 are the east and north unit vectors.
  out[o + AXIS_U] = _enu[0];
  out[o + AXIS_U + 1] = _enu[1];
  out[o + AXIS_U + 2] = _enu[2];
  out[o + AXIS_V] = _enu[4];
  out[o + AXIS_V + 1] = _enu[5];
  out[o + AXIS_V + 2] = _enu[6];
  const omega = (segment.turnRateDps || 0) * DEG;
  out[o + KIND] = SEGMENT_ARC;
  out[o + T0] = segment.t0;
  out[o + P1] = segment.minDt;
  out[o + P2] = segment.maxDt;
  out[o + SPEED] = segment.speedMps || 0;
  out[o + TRACK] = (segment.trackDeg || 0) * DEG;
  out[o + OMEGA] = Math.abs(omega) < STRAIGHT_BELOW_RAD_PER_SEC ? 0 : omega;
  out[o + COURSE0] = norm360(segment.trackDeg || 0);
}

/**
 * Glide the displayed course from `fromCourseDeg` onto the segment's own course,
 * at most `rateDps`, starting at `t0` (the rate limit at a segment boundary).
 * A rate of zero or less holds `fromCourseDeg` for the whole segment instead
 * (a hover: the nose keeps its heading however the track moves).
 * Call after writing the segment.
 * @param {Float32Array} out
 * @param {number} row
 * @param {number} fromCourseDeg
 * @param {number} t0
 * @param {number} rateDps
 */
export function writeCourseGlide(out, row, fromCourseDeg, t0, rateDps) {
  const o = row * SEGMENT_STRIDE;
  out[o + SLEW_OFFSET] = 0;
  const target = targetCourse(out, o, t0);
  out[o + SLEW_OFFSET] = norm180(fromCourseDeg - target);
  out[o + SLEW_T0] = t0;
  out[o + SLEW_RATE] = rateDps > 0 ? rateDps : -1;
}

/**
 * Move a row's stored times by `deltaSec` (the epoch moved by `-deltaSec`).
 * @param {Float32Array} out
 * @param {number} row
 * @param {number} deltaSec
 */
export function shiftSegmentTimes(out, row, deltaSec) {
  const o = row * SEGMENT_STRIDE;
  out[o + T0] += deltaSec;
  out[o + SLEW_T0] += deltaSec;
}

/** Elapsed fraction (lerp) or clamped elapsed seconds (arc) at `tau`. */
function segmentParameter(seg, o, tau) {
  const kind = seg[o + KIND];
  if (kind === SEGMENT_LERP) {
    const span = seg[o + P1];
    return span > 0 ? Math.min(1, Math.max(0, (tau - seg[o + T0]) / span)) : 1;
  }
  if (kind === SEGMENT_ARC)
    return Math.min(seg[o + P2], Math.max(seg[o + P1], tau - seg[o + T0]));
  return 0;
}

function sinc(x) {
  return Math.abs(x) < 1e-4 ? 1 - (x * x) / 6 : Math.sin(x) / x;
}

/**
 * The displayed course at `tau`, in degrees clockwise from north.
 * @param {Float32Array} seg
 * @param {number} row
 * @param {number} tau
 * @returns {number}
 */
export function segmentCourse(seg, row, tau) {
  const o = row * SEGMENT_STRIDE;
  const course = targetCourse(seg, o, tau);
  const offset = seg[o + SLEW_OFFSET];
  if (seg[o + SLEW_RATE] < 0)
    return norm360(targetCourse(seg, o, seg[o + SLEW_T0]) + offset);
  if (offset === 0) return norm360(course);
  // limitCourseStep: the displayed course turns at the rate toward the segment's
  // own (possibly turning) course until it reaches it, then follows it. The
  // segment's course is linear and unwrapped, so the gap needs no modulo.
  const t0 = seg[o + SLEW_T0];
  const toward = -Math.sign(offset);
  const start = targetCourse(seg, o, t0);
  const turned = seg[o + SLEW_RATE] * Math.max(0, tau - t0);
  const gap = toward * (course - start - offset);
  return norm360(turned < gap ? start + offset + toward * turned : course);
}

/**
 * The course the row glides toward at `tau` (its segment's own course).
 * @param {Float32Array} seg
 * @param {number} row
 * @param {number} tau
 * @returns {number}
 */
export function segmentTargetCourse(seg, row, tau) {
  return norm360(targetCourse(seg, row * SEGMENT_STRIDE, tau));
}

/** The segment's own course at `tau`, before any glide. */
function targetCourse(seg, o, tau) {
  const kind = seg[o + KIND];
  const p = segmentParameter(seg, o, tau);
  let course = seg[o + COURSE0];
  if (kind === SEGMENT_LERP) course += seg[o + COURSE_SLOPE] * p;
  else if (kind === SEGMENT_ARC) course += (seg[o + OMEGA] / DEG) * p;
  return course;
}

/**
 * Where the row is at `tau`, in ECEF.
 * @param {Float32Array} seg
 * @param {number} row
 * @param {number} tau
 * @param {Cesium.Cartesian3} [result]
 * @returns {Cesium.Cartesian3}
 */
export function segmentPosition(
  seg,
  row,
  tau,
  result = new Cesium.Cartesian3(),
) {
  const o = row * SEGMENT_STRIDE;
  let x = seg[o + BASE_HIGH] + seg[o + BASE_LOW];
  let y = seg[o + BASE_HIGH + 1] + seg[o + BASE_LOW + 1];
  let z = seg[o + BASE_HIGH + 2] + seg[o + BASE_LOW + 2];
  const kind = seg[o + KIND];
  if (kind === SEGMENT_LERP) {
    const f = segmentParameter(seg, o, tau);
    x += seg[o + AXIS_U] * f;
    y += seg[o + AXIS_U + 1] * f;
    z += seg[o + AXIS_U + 2] * f;
  } else if (kind === SEGMENT_ARC) {
    const dt = segmentParameter(seg, o, tau);
    const half = seg[o + OMEGA] * dt * 0.5;
    const reach = seg[o + SPEED] * dt * sinc(half);
    const heading = seg[o + TRACK] + half;
    const e = reach * Math.sin(heading);
    const n = reach * Math.cos(heading);
    x += seg[o + AXIS_U] * e + seg[o + AXIS_V] * n;
    y += seg[o + AXIS_U + 1] * e + seg[o + AXIS_V + 1] * n;
    z += seg[o + AXIS_U + 2] * e + seg[o + AXIS_V + 2] * n;
  }
  result.x = x;
  result.y = y;
  result.z = z;
  return result;
}

/**
 * GLSL for the same evaluation. Expects the six segment vec4s as `seg0`…`seg5`
 * (floats 0–3, 4–7, … of the packed row) and returns the eye-relative position in
 * `positionRte` and the course in degrees.
 */
export const ICON_SEGMENT_GLSL = /* glsl */ `
float iconSinc(float x) {
  return abs(x) < 1e-4 ? 1.0 - x * x / 6.0 : sin(x) / x;
}

float iconSegmentParameter(vec4 seg3, vec4 seg4, float tau) {
  float kind = seg3.x;
  if (kind == 1.0) {
    float span = seg3.z;
    return span > 0.0 ? clamp((tau - seg3.y) / span, 0.0, 1.0) : 1.0;
  }
  if (kind == 2.0) return clamp(tau - seg3.y, seg3.z, seg3.w);
  return 0.0;
}

vec3 iconSegmentPosition(vec4 seg0, vec4 seg1, vec4 seg2, vec4 seg3, vec4 seg4, float tau) {
  vec3 high = seg0.xyz;
  vec3 low = vec3(seg0.w, seg1.xy);
  vec3 axisU = vec3(seg1.zw, seg2.x);
  vec3 axisV = seg2.yzw;
  vec4 rte = czm_translateRelativeToEye(high, low);
  vec3 p = rte.xyz;
  float kind = seg3.x;
  float t = iconSegmentParameter(seg3, seg4, tau);
  if (kind == 1.0) {
    p += axisU * t;
  } else if (kind == 2.0) {
    float half_ = seg4.z * t * 0.5;
    float reach = seg4.x * t * iconSinc(half_);
    float heading = seg4.y + half_;
    p += axisU * (reach * sin(heading)) + axisV * (reach * cos(heading));
  }
  return p;
}

float iconTargetCourse(vec4 seg3, vec4 seg4, vec4 seg5, float tau) {
  float kind = seg3.x;
  float t = iconSegmentParameter(seg3, seg4, tau);
  float course = seg4.w;
  if (kind == 1.0) course += seg5.x * t;
  else if (kind == 2.0) course += degrees(seg4.z) * t;
  return course;
}

float iconSegmentCourse(vec4 seg3, vec4 seg4, vec4 seg5, float tau) {
  float course = iconTargetCourse(seg3, seg4, seg5, tau);
  float offset = seg5.y;
  if (seg5.w < 0.0) return iconTargetCourse(seg3, seg4, seg5, seg5.z) + offset;
  if (offset == 0.0) return course;
  float toward = -sign(offset);
  float start = iconTargetCourse(seg3, seg4, seg5, seg5.z);
  float turned = seg5.w * max(0.0, tau - seg5.z);
  float gap = toward * (course - start - offset);
  return turned < gap ? start + offset + toward * turned : course;
}
`;
