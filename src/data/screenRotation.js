/**
 * @module data/screenRotation
 * @description The screen rotation that points a camera-facing icon along
 * its real-world course, from the camera's right and up axes (a camera
 * port pose's `right` and `up`), and the deadband that holds it through
 * render noise. See `iconOrientation.js` for why the course is projected
 * onto the camera basis. No engine.
 */
import { eastNorthUp, frameVector } from '../geo/frames.js';
import { dot, toRadians, vec } from '../geo/vector.js';

/** Meters used to give the course vector a stable projection magnitude. */
const FORWARD_PROBE_M = 2000;
/**
 * Minimum camera-plane component before we trust the angle — below this the
 * course points almost exactly into/out of the screen and the angle is noise.
 */
const MIN_SCREEN_COMPONENT_M = 0.5;
/** Ignore sub-degree projection noise while retaining deliberate camera-orbit rotation. */
const ROTATION_DEADBAND_RAD = toRadians(0.5);

/**
 * The icon rotation (radians, counter-clockwise on screen, 0 pointing
 * screen-up) that points it along `courseDeg` at `position`, projected onto
 * the camera's `right` and `up` axes (ECEF).
 * @param {{right?: object, up?: object}|null} basis The camera's axes.
 * @param {{x: number, y: number, z: number}|null} position ECEF.
 * @param {number} courseDeg Degrees clockwise from north.
 * @param {number|null} [previous] Kept when the projection is unknown.
 * @returns {number|null}
 */
export function courseScreenRotation(
  basis,
  position,
  courseDeg,
  previous = null,
) {
  if (!basis?.right || !basis?.up || !position) return previous;
  const courseRad = toRadians(courseDeg || 0);
  const forward = frameVector(
    eastNorthUp(position),
    vec(
      Math.sin(courseRad) * FORWARD_PROBE_M,
      Math.cos(courseRad) * FORWARD_PROBE_M,
      0,
    ),
  );
  // Screen x follows camera-right; window y grows downward, against up.
  const dx = dot(forward, basis.right);
  const dy = -dot(forward, basis.up);
  if (dx * dx + dy * dy < MIN_SCREEN_COMPONENT_M * MIN_SCREEN_COMPONENT_M)
    return previous;
  // Icon direction in window coords after CCW rotation r is (-sin r, -cos r),
  // so matching the projected course (dx, dy) gives r = atan2(-dx, -dy).
  return Math.atan2(-dx, -dy);
}

/**
 * Hold a billboard rotation when the newly projected angle differs only by
 * sub-degree render noise. The comparison uses the shortest wrapped arc so
 * values around ±π do not jump.
 *
 * @param {number|null} previous Last displayed rotation.
 * @param {number|null} next Newly projected rotation.
 * @param {number} [deadbandRad=ROTATION_DEADBAND_RAD] Angular hold threshold.
 * @returns {number|null} Stable rotation.
 */
export function stabilizeScreenRotation(
  previous,
  next,
  deadbandRad = ROTATION_DEADBAND_RAD,
) {
  if (!Number.isFinite(next))
    return Number.isFinite(previous) ? previous : null;
  if (!Number.isFinite(previous)) return next;
  const delta = Math.atan2(
    Math.sin(next - previous),
    Math.cos(next - previous),
  );
  return Math.abs(delta) < Math.max(0, deadbandRad) ? previous : next;
}
