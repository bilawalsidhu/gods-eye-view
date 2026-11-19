import { isFollowing } from './data/followed.js';
import { geodeticSurfaceNormal, rayEllipsoid } from './geo/ellipsoid.js';
import { rotate } from './geo/frames.js';
import { clamp, dot, normalize, toRadians } from './geo/vector.js';
import { findCamera } from './render/rendererOf.js';

// The camera's free look (Shift+drag) turns the camera in place. Near the
// ground that surveys a city; from orbit a few drags turn the whole planet out
// of frame and leave only stars.
export const FREE_LOOK_MAX_HEIGHT_METERS = 1_000_000;

// A voice turn from orbit stops when about this share of the frame still shows
// the planet's surface.
export const MIN_GLOBE_FRAME_SHARE = 0.1;

/**
 * A free globe camera: the viewer follows nothing, and its camera is not
 * locked to a reference frame.
 */
export function isFreeGlobeCamera(viewer) {
  const camera = findCamera(viewer);
  return (
    Boolean(camera) && !isFollowing(viewer) && camera.pose().frameIsIdentity
  );
}

const GRID_COLUMNS = 32;
const GRID_ROWS = 18;
// A turn across a sliver of planet moves its edge through sample points, so
// the share wobbles by a cell or two without the planet leaving.
const GRID_NOISE_CELLS = 2;
// Whatever the baseline, a voice turn never takes the planet below this share
// of the frame; a view that already shows less may only keep what it has.
const LOOK_ABSOLUTE_FLOOR_SHARE = 0.01;

const sampleRay = { origin: null, direction: { x: 0, y: 0, z: 0 } };

/**
 * Cast a 32×18 grid of view rays, one through the centre of each cell, at the
 * WGS84 ellipsoid. With `keyholeRadius` (a radius around the frame centre, in
 * units of half the frame height) only the cells inside that circle count: the
 * scope mask hides the rest. Returns the surface hits and the cells counted, or
 * null for a pose with no perspective view to sample.
 * @param {import('./render/contract/camera').CameraPose} pose
 */
function sampleFrame(pose, keyholeRadius) {
  if (!Number.isFinite(pose?.fovy) || !Number.isFinite(pose.aspectRatio))
    return null;
  const aspect = pose.aspectRatio;
  const tanY = Math.tan(pose.fovy / 2);
  const tanX = tanY * aspect;
  const keyholeSquared = keyholeRadius > 0 ? keyholeRadius * keyholeRadius : 0;
  const { direction, right, up } = pose;
  sampleRay.origin = pose.position;
  const ray = sampleRay.direction;
  let hits = 0;
  let cells = 0;
  for (let row = 0; row < GRID_ROWS; row += 1) {
    const rowY = (2 * (row + 0.5)) / GRID_ROWS - 1;
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const columnX = (2 * (column + 0.5)) / GRID_COLUMNS - 1;
      if (
        keyholeSquared &&
        (columnX * aspect) ** 2 + rowY * rowY > keyholeSquared
      )
        continue;
      cells += 1;
      const x = columnX * tanX;
      const y = rowY * tanY;
      ray.x = direction.x + right.x * x + up.x * y;
      ray.y = direction.y + right.y * x + up.y * y;
      ray.z = direction.z + right.z * x + up.z * y;
      const length = Math.hypot(ray.x, ray.y, ray.z);
      ray.x /= length;
      ray.y /= length;
      ray.z /= length;
      if (rayEllipsoid(sampleRay)) hits += 1;
    }
  }
  return { hits, cells };
}

/**
 * Share of the frame, from 0 to 1, that shows the planet's surface: the
 * fraction of a 32×18 grid of view rays, one through the centre of each cell,
 * that hit the WGS84 ellipsoid. With `keyholeRadius` (see `sampleFrame`) it is
 * the share of the visible circle instead. A pose with no perspective view
 * counts as fully covered.
 * @param {import('./render/contract/camera').CameraPose} pose
 */
export function globeFrameShare(pose, { keyholeRadius = 0 } = {}) {
  const sample = sampleFrame(pose, keyholeRadius);
  if (!sample || sample.cells === 0) return 1;
  return sample.hits / sample.cells;
}

/** True when none of the planet's surface is in `pose`'s visible frame. */
export function globeOutOfFrame(pose, options) {
  return globeFrameShare(pose, options) === 0;
}

/**
 * `pose` after an in-place look (`'up'`, `'down'`, `'left'` or `'right'`) by
 * `angle` radians, as the camera port's `look` turns it: up and down about
 * the view's right axis, left and right about its up axis. The eye stays.
 * @param {import('./render/contract/camera').CameraPose} pose
 * @returns {import('./render/contract/camera').CameraPose} With `direction`,
 *   `up`, `right` and `pitch` turned; the other angles are not recomputed.
 */
export function lookedPose(pose, look, angle) {
  const vertical = look === 'up' || look === 'down';
  const axis = vertical ? pose.right : pose.up;
  const turn = look === 'up' || look === 'left' ? angle : -angle;
  const direction = normalize(rotate(pose.direction, axis, turn));
  const next = {
    ...pose,
    direction,
    ...(vertical
      ? { up: normalize(rotate(pose.up, axis, turn)) }
      : { right: normalize(rotate(pose.right, axis, turn)) }),
  };
  next.pitch = posePitch(next);
  return next;
}

/**
 * The pitch of a world-frame pose: its direction's angle above the local
 * horizontal at the eye (negative looking down).
 * @param {import('./render/contract/camera').CameraPose} pose
 */
export function posePitch(pose) {
  return Math.asin(
    clamp(dot(pose.direction, geodeticSurfaceNormal(pose.position)), -1, 1),
  );
}

const LOOK_EDGE_TOLERANCE = toRadians(0.05);

/**
 * How much of one in-place look step (`'up'`, `'down'`, `'left'` or `'right'`
 * by a non-negative `angle` in radians) keeps the planet in frame from orbit.
 * Above the free-look height the step may not leave less than
 * `MIN_GLOBE_FRAME_SHARE` of the visible frame on the planet, or less than
 * `startShare` when that is lower, give or take two grid cells of sampling
 * noise. However the baseline was taken, it never leaves less than 1% of the
 * frame, and a view that already shows less may only keep or gain what it has.
 * `startShare` is the baseline the turn is measured against (the current share
 * by default): callers pass one value to every step of a motion, and to every
 * turn that continues from where the last one left off, so the limit cannot
 * slide down a step or a command at a time. `keyholeRadius` limits the measure
 * to the scope's visible circle, as in `globeFrameShare`.
 * With nothing on screen the limit is nothing either, so the step is left to
 * the move-end recovery. Returns `angle` when the whole step fits, otherwise a
 * smaller angle that fits, found by bisection to within 0.05°, so a stopped
 * motion rests at the limit. Steps are tried on the pose; no camera is moved.
 * @param {import('./render/contract/camera').CameraPose} pose
 */
export function lookAngleWithinFrame(
  pose,
  look,
  angle,
  { startShare, keyholeRadius = 0 } = {},
) {
  if (!(angle > 0) || !(pose?.height > FREE_LOOK_MAX_HEIGHT_METERS))
    return angle;
  const sample = sampleFrame(pose, keyholeRadius);
  if (!sample || sample.cells === 0) return angle;
  const share = sample.hits / sample.cells;
  const baseline = startShare ?? share;
  // Capped at what is on screen now, so a step that keeps or gains surface is
  // never refused, even when the frame has shrunk since the baseline was taken
  // (a resized window or a turned phone).
  const floor = Math.min(
    share,
    Math.max(
      Math.min(MIN_GLOBE_FRAME_SHARE, baseline) -
        GRID_NOISE_CELLS / sample.cells,
      Math.min(LOOK_ABSOLUTE_FLOOR_SHARE, baseline),
    ),
  );
  // Shares are whole grid cells; the epsilon keeps rounding in `floor` from
  // costing a cell.
  const fits = (step) =>
    globeFrameShare(lookedPose(pose, look, step), { keyholeRadius }) >=
    floor - 1e-9;
  if (fits(angle)) return angle;
  let inside = 0;
  let outside = angle;
  while (outside - inside > LOOK_EDGE_TOLERANCE) {
    const middle = (inside + outside) / 2;
    if (fits(middle)) inside = middle;
    else outside = middle;
  }
  return inside;
}

/** True when an in-place look step of `angle` would lose part of its turn. */
export function lookStepLosesGlobe(pose, look, angle, options) {
  return lookAngleWithinFrame(pose, look, angle, options) < angle;
}
