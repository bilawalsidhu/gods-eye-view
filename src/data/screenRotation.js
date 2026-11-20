/**
 * @module data/screenRotation
 * @description The screen rotation that points a camera-facing icon along
 * its real-world course, from the camera's right and up axes (a camera
 * port pose's `right` and `up`), and the deadband that holds it through
 * render noise. See `iconOrientation.js` for why the course is projected
 * onto the camera basis. No engine.
 */
import { WGS84 } from '../geo/ellipsoid.js';
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

/**
 * Metres ahead `perspectiveCourseRotation` probes: short, so the projection
 * is local to the contact (a two kilometre probe on a bus seen from six
 * hundred metres would sample a part of the view the bus is nowhere near).
 */
export const PERSPECTIVE_PROBE_M = 30;
/**
 * Probe separations (CSS px) across which the exact and camera-basis
 * answers are blended: at or below the floor the camera-basis answer alone,
 * at or above the ceiling the exact one.
 */
export const PERSPECTIVE_BLEND_MIN_PX = 0.5;
export const PERSPECTIVE_BLEND_MAX_PX = 3;

/**
 * The icon rotation (as `courseScreenRotation`'s) that points a SURFACE
 * contact along `courseDeg`, projected exactly, perspective division
 * included: the contact and a point `PERSPECTIVE_PROBE_M` ahead of it are
 * projected through `project` (a query port's `project`) and the angle
 * between them read on screen. The camera-basis answer is orthographic,
 * exact at the view's centre and wrong by twenty-odd degrees for a
 * street-level contact away from it in an oblique view. Where either point
 * cannot be projected it falls back to the camera-basis answer; below a few
 * pixels of separation, where projection noise rules the exact one, the
 * two are blended the short way round, so the rotation is continuous.
 * @param {(p: {x: number, y: number, z: number}) => ({x: number, y: number}|null)} project
 * @param {{right?: object, up?: object}|null} basis The camera's axes.
 * @param {{x: number, y: number, z: number}|null} position ECEF.
 * @param {number} courseDeg Degrees clockwise from north.
 * @param {number|null} [previous] Kept when the rotation is unknown.
 * @returns {number|null}
 */
export function perspectiveCourseRotation(
  project,
  basis,
  position,
  courseDeg,
  previous = null,
) {
  if (!project || !position || !Number.isFinite(courseDeg)) return previous;
  if (!courseProbeInto(position, courseDeg, probeScratch)) {
    // At a pole, through the frame `eastNorthUp` defines there.
    const courseRad = toRadians(courseDeg);
    const forward = frameVector(
      eastNorthUp(position),
      vec(
        Math.sin(courseRad) * PERSPECTIVE_PROBE_M,
        Math.cos(courseRad) * PERSPECTIVE_PROBE_M,
        0,
      ),
    );
    probeScratch.x = position.x + forward.x;
    probeScratch.y = position.y + forward.y;
    probeScratch.z = position.z + forward.z;
  }
  const at = project(position);
  const atX = at?.x;
  const atY = at?.y;
  const ahead = at ? project(probeScratch) : null;
  if (!at || !ahead)
    return courseScreenRotation(basis, position, courseDeg, previous);
  const dx = ahead.x - atX;
  const dy = ahead.y - atY;
  const separation = Math.hypot(dx, dy);
  // Window y grows downward; rotation 0 points the icon screen-up.
  const exact = Math.atan2(-dx, -dy);
  if (separation >= PERSPECTIVE_BLEND_MAX_PX) return exact;
  const camera = courseScreenRotation(basis, position, courseDeg, previous);
  if (!Number.isFinite(camera)) return exact;
  if (separation <= PERSPECTIVE_BLEND_MIN_PX) return camera;
  const weight =
    (separation - PERSPECTIVE_BLEND_MIN_PX) /
    (PERSPECTIVE_BLEND_MAX_PX - PERSPECTIVE_BLEND_MIN_PX);
  const delta = Math.atan2(Math.sin(exact - camera), Math.cos(exact - camera));
  return camera + delta * weight;
}

// The probe point, reused: the rotation pass visits every visible contact.
const probeScratch = { x: 0, y: 0, z: 0 };

/**
 * The point `PERSPECTIVE_PROBE_M` ahead of `position` along `courseDeg` on
 * its east-north plane (as `eastNorthUp` and `frameVector` give it), into
 * `out`, allocating nothing. False at a pole, where `eastNorthUp` picks
 * its own east.
 */
function courseProbeInto(position, courseDeg, out) {
  const { x, y, z } = position;
  // `eastNorthUp`'s own test for a pole.
  if (Math.abs(x) <= 1e-14 && Math.abs(y) <= 1e-14) return false;
  const eastLength = Math.hypot(x, y);
  const o = WGS84.oneOverRadiiSquared;
  let ux = x * o.x,
    uy = y * o.y,
    uz = z * o.z;
  const upLength = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= upLength;
  uy /= upLength;
  uz /= upLength;
  const ex = -y / eastLength,
    ey = x / eastLength;
  // North is up × east (east has no z).
  const nx = -uz * ey,
    ny = uz * ex,
    nz = ux * ey - uy * ex;
  const courseRad = toRadians(courseDeg);
  const e = Math.sin(courseRad) * PERSPECTIVE_PROBE_M;
  const n = Math.cos(courseRad) * PERSPECTIVE_PROBE_M;
  out.x = x + ex * e + nx * n;
  out.y = y + ey * e + ny * n;
  out.z = z + nz * n;
  return true;
}
