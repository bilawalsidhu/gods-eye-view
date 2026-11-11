import * as Cesium from 'cesium';

// Cesium's free look (Shift+drag) turns the camera in place. Near the ground
// that surveys a city; from orbit a few drags turn the whole planet out of
// frame and leave only stars.
export const FREE_LOOK_MAX_HEIGHT_METERS = 1_000_000;

// A voice turn from orbit stops when about this share of the frame still shows
// the planet's surface.
export const MIN_GLOBE_FRAME_SHARE = 0.1;

/**
 * A free globe camera: the viewer is in 3D, follows no tracked entity, and its
 * camera is not locked to a reference frame.
 */
export function isFreeGlobeCamera(viewer) {
  return (
    viewer.scene.mode === Cesium.SceneMode.SCENE3D &&
    !viewer.trackedEntity &&
    Cesium.Matrix4.equals(viewer.camera.transform, Cesium.Matrix4.IDENTITY)
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
const sampleRay = new Cesium.Ray();
const sampleOffset = new Cesium.Cartesian3();

/**
 * Cast a 32×18 grid of view rays, one through the centre of each cell, at the
 * WGS84 ellipsoid. With `keyholeRadius` (a radius around the frame centre, in
 * units of half the frame height) only the cells inside that circle count: the
 * scope mask hides the rest. Returns the surface hits and the cells counted, or
 * null for a frustum other than a perspective one.
 */
function sampleFrame(camera, keyholeRadius) {
  const frustum = camera.frustum;
  if (!(frustum instanceof Cesium.PerspectiveFrustum)) return null;
  const aspect = frustum.aspectRatio;
  const tanY = Math.tan(frustum.fovy / 2);
  const tanX = tanY * aspect;
  const keyholeSquared = keyholeRadius > 0 ? keyholeRadius * keyholeRadius : 0;
  Cesium.Cartesian3.clone(camera.positionWC, sampleRay.origin);
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
      Cesium.Cartesian3.multiplyByScalar(
        camera.rightWC,
        columnX * tanX,
        sampleOffset,
      );
      Cesium.Cartesian3.add(
        camera.directionWC,
        sampleOffset,
        sampleRay.direction,
      );
      Cesium.Cartesian3.multiplyByScalar(
        camera.upWC,
        rowY * tanY,
        sampleOffset,
      );
      Cesium.Cartesian3.add(
        sampleRay.direction,
        sampleOffset,
        sampleRay.direction,
      );
      Cesium.Cartesian3.normalize(sampleRay.direction, sampleRay.direction);
      if (
        Cesium.IntersectionTests.rayEllipsoid(sampleRay, Cesium.Ellipsoid.WGS84)
      )
        hits += 1;
    }
  }
  return { hits, cells };
}

/**
 * Share of the frame, from 0 to 1, that shows the planet's surface: the
 * fraction of a 32×18 grid of view rays, one through the centre of each cell,
 * that hit the WGS84 ellipsoid. With `keyholeRadius` (see `sampleFrame`) it is
 * the share of the visible circle instead. A frustum other than a perspective
 * one counts as fully covered.
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

const lookProbes = new WeakMap();
const LOOK_EDGE_TOLERANCE = Cesium.Math.toRadians(0.05);

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
 * motion rests at the limit. Steps are tried on a copy; `camera` is not moved.
 */
export function lookAngleWithinFrame(
  camera,
  look,
  angle,
  { startShare, keyholeRadius = 0 } = {},
) {
  if (
    !(angle > 0) ||
    !(camera.positionCartographic?.height > FREE_LOOK_MAX_HEIGHT_METERS)
  )
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
  const fits = (step) => {
    const probe = Cesium.Camera.clone(camera, lookProbes.get(camera));
    lookProbes.set(camera, probe);
    probe[look](step);
    // Shares are whole grid cells; the epsilon keeps rounding in `floor` from
    // costing a cell.
    return globeFrameShare(probe, { keyholeRadius }) >= floor - 1e-9;
  };
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
