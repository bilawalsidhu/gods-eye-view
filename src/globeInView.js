// Engine-neutral: a camera here is a pose (see `CameraPose` below), and the
// maths run on src/geo, so the same checks hold for Cesium, Navara and the
// fake engine. Never imports Cesium.
import * as geo from './geo/index.js';

const { cartesian3, math } = geo;
const WGS84 = geo.ellipsoid.WGS84;

// Cesium's free look (Shift+drag) turns the camera in place. Near the ground
// that surveys a city; from orbit a few drags turn the whole planet out of
// frame and leave only stars.
export const FREE_LOOK_MAX_HEIGHT_METERS = 1_000_000;

// A voice turn from orbit stops when about this share of the frame still shows
// the planet's surface.
export const MIN_GLOBE_FRAME_SHARE = 0.1;

/**
 * @typedef {object} CameraPose A camera, as the globe contract's
 *   `camera.pose()` gives it plus the eye's height.
 * @property {{x:number,y:number,z:number}} position Earth-fixed metres.
 * @property {{x:number,y:number,z:number}} direction Unit view direction.
 * @property {{x:number,y:number,z:number}} up Unit screen up.
 * @property {{x:number,y:number,z:number}} [right] Unit screen right
 *   (direction × up when absent).
 * @property {number} fovy Vertical field of view, radians.
 * @property {number} aspectRatio Width over height.
 * @property {number} height Ellipsoid height of the eye, metres.
 * @property {boolean} [perspective] False for a frustum other than a
 *   perspective one.
 */

/**
 * A free globe camera: the engine's camera follows nothing and is not locked
 * to a reference frame (identity transform). Both engines draw only the 3D
 * globe.
 * @param {import('./globe/contract.js').GlobeEngine} engine
 */
export function isFreeGlobeCamera(engine) {
  const camera = engine?.camera;
  if (!camera) return false;
  return (
    !camera.following() &&
    camera
      .transform()
      .every((value, index) => value === geo.matrix4.IDENTITY[index])
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
const sampleDirection = cartesian3.create();
const sampleOffset = cartesian3.create();
const scratchQ = cartesian3.create();
const scratchW = cartesian3.create();

/**
 * Whether a ray from `origin` along `direction` meets the WGS84 ellipsoid:
 * Cesium's IntersectionTests.rayEllipsoid, answering only hit or miss.
 */
function rayHitsEllipsoid(origin, direction) {
  const inverseRadii = WGS84.oneOverRadii;
  const q = cartesian3.multiplyComponents(inverseRadii, origin, scratchQ);
  const w = cartesian3.multiplyComponents(inverseRadii, direction, scratchW);
  const q2 = cartesian3.magnitudeSquared(q);
  const qw = cartesian3.dot(q, w);
  if (q2 > 1.0) {
    // Outside the ellipsoid: looking outward or tangent misses; otherwise it
    // hits unless the roots are imaginary.
    if (qw >= 0.0) return false;
    const product = cartesian3.magnitudeSquared(w) * (q2 - 1.0);
    return !(qw * qw < product);
  }
  // Inside the ellipsoid every ray hits; on it, only one looking inward.
  if (q2 < 1.0) return true;
  return qw < 0.0;
}

/** The pose's screen-right vector. */
function rightOf(camera) {
  return (
    camera.right ??
    cartesian3.normalize(
      cartesian3.cross(camera.direction, camera.up, cartesian3.create()),
      cartesian3.create(),
    )
  );
}

/**
 * Cast a 32×18 grid of view rays, one through the centre of each cell, at the
 * WGS84 ellipsoid. With `keyholeRadius` (a radius around the frame centre, in
 * units of half the frame height) only the cells inside that circle count: the
 * scope mask hides the rest. Returns the surface hits and the cells counted, or
 * null for a frustum other than a perspective one, or a pose with no view
 * basis to cast rays along.
 */
function sampleFrame(camera, keyholeRadius) {
  if (
    camera.perspective === false ||
    !(camera.fovy > 0) ||
    !(camera.aspectRatio > 0) ||
    !camera.position ||
    !camera.direction ||
    !camera.up
  )
    return null;
  const aspect = camera.aspectRatio;
  const tanY = Math.tan(camera.fovy / 2);
  const tanX = tanY * aspect;
  const keyholeSquared = keyholeRadius > 0 ? keyholeRadius * keyholeRadius : 0;
  const right = rightOf(camera);
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
      cartesian3.multiplyByScalar(right, columnX * tanX, sampleOffset);
      cartesian3.add(camera.direction, sampleOffset, sampleDirection);
      cartesian3.multiplyByScalar(camera.up, rowY * tanY, sampleOffset);
      cartesian3.add(sampleDirection, sampleOffset, sampleDirection);
      cartesian3.normalize(sampleDirection, sampleDirection);
      if (rayHitsEllipsoid(camera.position, sampleDirection)) hits += 1;
    }
  }
  return { hits, cells };
}

/**
 * Share of the frame, from 0 to 1, that shows the planet's surface: the
 * fraction of a 32×18 grid of view rays, one through the centre of each cell,
 * that hit the WGS84 ellipsoid. With `keyholeRadius` (see `sampleFrame`) it is
 * the share of the visible circle instead. A frustum other than a perspective
 * one (or a pose with no view basis) counts as fully covered.
 * @param {CameraPose} camera
 */
export function globeFrameShare(camera, { keyholeRadius = 0 } = {}) {
  const sample = sampleFrame(camera, keyholeRadius);
  if (!sample || sample.cells === 0) return 1;
  return sample.hits / sample.cells;
}

/** True when none of the planet's surface is in `camera`'s visible frame. */
export function globeOutOfFrame(camera, options) {
  return globeFrameShare(camera, options) === 0;
}

/**
 * `camera` after an in-place look (`lookUp`, `lookDown`, `lookLeft` or
 * `lookRight` by `angle` radians), as Cesium's camera turns: direction, up and
 * right rotate about the right vector (up/down) or the up vector (left/right);
 * the position stays. Returns a new pose; `camera` is not changed.
 * @param {CameraPose} camera
 * @returns {CameraPose}
 */
export function lookPose(camera, look, angle) {
  const right = rightOf(camera);
  const vertical = look === 'lookUp' || look === 'lookDown';
  const sign = look === 'lookUp' || look === 'lookLeft' ? 1 : -1;
  const rotation = geo.matrix3.fromQuaternion(
    geo.quaternion.fromAxisAngle(
      vertical ? right : camera.up,
      sign * angle,
      geo.quaternion.create(),
    ),
    geo.matrix3.create(),
  );
  const turn = (vector) =>
    geo.matrix3.multiplyByVector(rotation, vector, cartesian3.create());
  return {
    ...camera,
    position: cartesian3.clone(camera.position),
    direction: turn(camera.direction),
    up: turn(camera.up),
    right: turn(right),
  };
}

/**
 * The camera's pitch, as Cesium's camera reports it: the angle of the view
 * direction above the local horizontal (the geodetic normal's plane) at the
 * eye.
 * @param {CameraPose} camera
 */
export function posePitch(camera) {
  const frame = geo.transforms.eastNorthUpToFixedFrame(camera.position, WGS84);
  const up = cartesian3.create(frame[8], frame[9], frame[10]);
  return (
    math.PI_OVER_TWO -
    Math.acos(math.clamp(cartesian3.dot(up, camera.direction), -1, 1))
  );
}

const LOOK_EDGE_TOLERANCE = math.toRadians(0.05);

/**
 * How much of one in-place look step (`lookUp`, `lookDown`, `lookLeft` or
 * `lookRight` by a non-negative `angle` in radians) keeps the planet in frame
 * from orbit. Above the free-look height the step may not leave less than
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
 * motion rests at the limit. Steps are tried on a copy of the pose (see
 * `lookPose`); `camera` is not moved.
 * @param {CameraPose} camera
 */
export function lookAngleWithinFrame(
  camera,
  look,
  angle,
  { startShare, keyholeRadius = 0 } = {},
) {
  if (!(angle > 0) || !(camera.height > FREE_LOOK_MAX_HEIGHT_METERS))
    return angle;
  const sample = sampleFrame(camera, keyholeRadius);
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
  const fits = (step) =>
    // Shares are whole grid cells; the epsilon keeps rounding in `floor` from
    // costing a cell.
    globeFrameShare(lookPose(camera, look, step), { keyholeRadius }) >=
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
export function lookStepLosesGlobe(camera, look, angle, options) {
  return lookAngleWithinFrame(camera, look, angle, options) < angle;
}
