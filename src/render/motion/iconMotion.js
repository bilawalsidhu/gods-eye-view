/**
 * @module render/motion/iconMotion
 * @description Where an icon item is drawn at a time, and the course it is
 * drawn with, from its contract `motion` segment and `courseGlide` (see
 * `MotionSegment` and `CourseGlide` in `render/contract/draw.d.ts`). The app
 * reads a moving icon back with it (to follow it, label it, judge a pick or
 * its horizon) instead of asking the renderer; the renderer evaluates its
 * segments with it on the CPU, and the Cesium port's GPU icons draw the
 * same path (`data/iconSegment.js` packs it, the shader evaluates it).
 *
 * Times are epoch ms on the set's motion clock. Plain numbers and `{x, y, z}`
 * objects only: no renderer is imported.
 *
 * Choices the contract leaves open, as the default renderer takes them:
 * - A `lerp` whose `t1` is not after `t0` runs from `from` to `to` over the
 *   1 ms after `t0` (the default renderer's GPU icons widen its span so).
 * - Turn rates under 1e-4 rad/s fly straight.
 * - A segment's course is its own (`hold.courseDeg`, `lerp.course0Deg`, the
 *   arc's track), else the item's `course`, else north.
 * - A glide turns the shorter way from `fromCourseDeg` onto the segment's
 *   course at `rateDps`, then follows it; a rate of 0 or less holds
 *   `fromCourseDeg` for the whole segment.
 */
import { positionToEcef } from '../../geo/ellipsoid.js';
import { eastNorthUp } from '../../geo/frames.js';
import { norm180, norm360 } from '../../geo/vector.js';

export { norm180, norm360 };

/** Turn rates under this (rad/s) fly straight. */
export const STRAIGHT_BELOW_RAD_PER_S = 1e-4;
/** How long (ms) a `lerp` with no span takes to step to `to`. */
export const LERP_STEP_MS = 1;

const DEG = Math.PI / 180;

/** A lerp's elapsed fraction at `t`, 0..1. */
function lerpFraction(segment, t) {
  const span = Math.max(segment.t1 - segment.t0, LERP_STEP_MS);
  return Math.min(1, Math.max(0, (t - segment.t0) / span));
}

/** An arc's elapsed seconds at `t`, clamped to `[minDtS, maxDtS]`. */
function arcSeconds(segment, t) {
  return Math.min(
    segment.maxDtS,
    Math.max(segment.minDtS, (t - segment.t0) / 1000),
  );
}

/** An arc's turn rate, rad/s: 0 under the straight threshold. */
function arcOmega(segment) {
  const omega = (segment.turnRateDps || 0) * DEG;
  return Math.abs(omega) < STRAIGHT_BELOW_RAD_PER_S ? 0 : omega;
}

function sinc(x) {
  return Math.abs(x) < 1e-4 ? 1 - (x * x) / 6 : Math.sin(x) / x;
}

/**
 * Where `segment` puts an icon at `t`, ECEF.
 * @param {import('../contract/draw').MotionSegment|undefined} segment
 * @param {import('../contract/common').Position} pos The item's own
 *   position (a `hold`'s, or with no segment).
 * @param {number} t Epoch ms on the set's motion clock.
 * @returns {{x: number, y: number, z: number}}
 */
export function motionPosition(segment, pos, t) {
  switch (segment?.kind) {
    case 'lerp': {
      const f = lerpFraction(segment, t);
      const { from, to } = segment;
      return {
        x: from.x + (to.x - from.x) * f,
        y: from.y + (to.y - from.y) * f,
        z: from.z + (to.z - from.z) * f,
      };
    }
    case 'arc': {
      const dt = arcSeconds(segment, t);
      // cos a − cos(a+b) = 2 sin(b/2) sin(a+b/2): the same path straight or
      // turning, with no cancellation.
      const half = arcOmega(segment) * dt * 0.5;
      const reach = (segment.speedMps || 0) * dt * sinc(half);
      const heading = (segment.trackDeg || 0) * DEG + half;
      const e = reach * Math.sin(heading);
      const n = reach * Math.cos(heading);
      const u = (segment.climbMps || 0) * dt;
      const { x: east, y: north, z: up } = eastNorthUp(segment.fix);
      const fix = segment.fix;
      return {
        x: fix.x + east.x * e + north.x * n + up.x * u,
        y: fix.y + east.y * e + north.y * n + up.y * u,
        z: fix.z + east.z * e + north.z * n + up.z * u,
      };
    }
    case 'hold':
    case undefined:
      return positionToEcef(pos);
    default:
      throw new Error(`unknown motion segment ${segment.kind}`);
  }
}

/**
 * The segment's own course at `t`, unwrapped (before any glide), from its
 * start course in [0, 360).
 */
function segmentCourseAt(segment, course, t) {
  switch (segment?.kind) {
    case 'lerp':
      return (
        norm360(segment.course0Deg ?? course ?? 0) +
        (segment.courseSlopeDeg || 0) * lerpFraction(segment, t)
      );
    case 'arc':
      return (
        norm360(segment.trackDeg || 0) +
        (arcOmega(segment) / DEG) * arcSeconds(segment, t)
      );
    case 'hold':
      return norm360(segment.courseDeg ?? course ?? 0);
    default:
      return norm360(course ?? 0);
  }
}

/**
 * How far (degrees, (-180, 180]) a glide starts from its segment's course at
 * the glide's start: its sign is the way it turns. A renderer packing the
 * glide writes this offset, so an exact half turn goes the way the app reads.
 * @param {import('../contract/draw').MotionSegment|undefined} segment
 * @param {number|undefined} course The item's own `course`.
 * @param {import('../contract/draw').CourseGlide} glide
 */
export function glideOffset(segment, course, glide) {
  return norm180(
    glide.fromCourseDeg - segmentCourseAt(segment, course, glide.t0),
  );
}

/**
 * The course an icon is drawn with at `t`, degrees clockwise from north in
 * [0, 360): its segment's, eased by `glide` when it has one.
 * @param {import('../contract/draw').MotionSegment|undefined} segment
 * @param {number|undefined} course The item's own `course`.
 * @param {number} t Epoch ms on the set's motion clock.
 * @param {import('../contract/draw').CourseGlide} [glide]
 * @returns {number}
 */
export function motionCourse(segment, course, t, glide) {
  const target = segmentCourseAt(segment, course, t);
  if (!glide) return norm360(target);
  const start = segmentCourseAt(segment, course, glide.t0);
  const offset = glideOffset(segment, course, glide);
  // Held: the course at the glide's start, whatever the segment does.
  if (!(glide.rateDps > 0)) return norm360(start + offset);
  if (offset === 0) return norm360(target);
  // Turning toward the segment's (unwrapped, maybe turning) course at the
  // rate until it reaches it, then following it.
  const toward = -Math.sign(offset);
  const turned = glide.rateDps * (Math.max(0, t - glide.t0) / 1000);
  const gap = toward * (target - start - offset);
  return norm360(turned < gap ? start + offset + toward * turned : target);
}

/**
 * Where an icon item is drawn at `t`: along its `motion`, else at its `pos`.
 * Pass the item without `motion` for a renderer without `motionSegments`.
 * @param {{pos: object, motion?: object}} item
 * @param {number} t Epoch ms on the set's motion clock.
 */
export function iconPosition(item, t) {
  return motionPosition(item.motion, item.pos, t);
}

/**
 * The course an icon item is drawn with at `t` (for `rotationMode:
 * 'course'`): its motion's, eased by its `courseGlide`. Pass the item without
 * them for a renderer without `motionSegments` or `courseGlide`.
 * @param {{course?: number, motion?: object, courseGlide?: object}} item
 * @param {number} t Epoch ms on the set's motion clock.
 */
export function iconCourse(item, t) {
  return motionCourse(item.motion, item.course, t, item.courseGlide);
}

/**
 * Until when (epoch ms) an item's drawn position or course may still
 * change: -Infinity for one that holds still, Infinity for none that ends.
 * @param {{motion?: object, courseGlide?: object}} item
 */
export function motionEndsAt(item) {
  const motion = item.motion;
  let end = -Infinity;
  if (motion?.kind === 'lerp')
    end = Math.max(motion.t1, motion.t0 + LERP_STEP_MS);
  else if (motion?.kind === 'arc') end = motion.t0 + motion.maxDtS * 1000;
  const glide = item.courseGlide;
  // Turning at most half a turn at its rate.
  if (glide?.rateDps > 0)
    end = Math.max(end, glide.t0 + (180 / glide.rateDps) * 1000);
  return end;
}
