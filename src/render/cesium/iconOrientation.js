/**
 * @module render/cesium/iconOrientation
 * @description The icon orientation and horizon helpers that read a Cesium
 * scene or camera: the camera-basis course rotation, the exact perspective
 * rotation for surface contacts, the shared horizon occluder and the camera
 * pose signature. Why the course is projected the way it is, and the
 * engine-free pieces (`skyBackdropFactor`, `stabilizeScreenRotation`), are
 * in `src/data/iconOrientation.js` and `src/data/screenRotation.js`.
 */
import * as Cesium from 'cesium';
import { poseSignature } from '../camera/poseSignature.js';
import { courseScreenRotation } from '../../data/screenRotation.js';

const _scratchEnu = new Cesium.Matrix4();
const _scratchForward = new Cesium.Cartesian3();
const _scratchWorldForward = new Cesium.Cartesian3();

/**
 * Computes the billboard rotation (radians, CCW-positive, for
 * alignedAxis = Cartesian3.ZERO) that points an icon along its real-world
 * course in the stable camera-basis approximation described in
 * `src/data/iconOrientation.js`; the
 * scene's camera axes in `screenRotation.js`'s `courseScreenRotation`.
 *
 * @param {Cesium.Scene} scene - The scene (projection source).
 * @param {Cesium.Cartesian3} position - Entity world position.
 * @param {number} courseDeg - Course/track in degrees clockwise from north.
 * @param {number|null} previous - Rotation to keep when projection is
 *   unavailable (off-screen/behind camera/degenerate).
 * @returns {number|null} Rotation in radians, or `previous` when unknown.
 */
export function screenProjectedRotation(
  scene,
  position,
  courseDeg,
  previous = null,
) {
  const camera = scene?.camera;
  return courseScreenRotation(
    camera && { right: camera.rightWC, up: camera.upWC },
    position,
    courseDeg,
    previous,
  );
}

const _occluder = new Cesium.EllipsoidalOccluder(
  Cesium.Ellipsoid.WGS84,
  new Cesium.Cartesian3(),
);

/**
 * Returns the shared horizon occluder, updated to the camera's position.
 * With the Cesium globe hidden (Google 3D tiles provide the planet) nothing
 * writes far-side depth, so billboards must be horizon-culled manually.
 * Call once per tick, then test points with occluder.isPointVisible(pos).
 *
 * @param {Cesium.Camera} camera - The scene camera.
 * @returns {Cesium.EllipsoidalOccluder}
 */
export function horizonOccluder(camera) {
  _occluder.cameraPosition = camera.positionWC;
  return _occluder;
}

/**
 * Cheap camera pose signature for "did the camera move" gating of rotation
 * passes (position quantized to ~10m, angles to ~0.06 deg).
 * @param {Cesium.Camera} camera - The scene camera.
 * @returns {string}
 */
export function cameraPoseSignature(camera) {
  return poseSignature({
    position: camera.positionWC,
    heading: camera.heading,
    pitch: camera.pitch,
    roll: camera.roll,
  });
}

/**
 * Meters ahead used by the exact projection below. Short on purpose: the point
 * of a perspective projection is that it is LOCAL to the contact, and a two
 * kilometre probe on a bus at six hundred metres would sample a part of the
 * frustum the vehicle is nowhere near.
 */
const NEAR_PROBE_M = 30;
const _scratchProbe = new Cesium.Cartesian3();
const _scratchWindowAt = new Cesium.Cartesian2();
const _scratchWindowAhead = new Cesium.Cartesian2();

/**
 * Billboard rotation for a SURFACE contact, projected exactly — perspective
 * division included — instead of through the camera-basis approximation.
 *
 * `screenProjectedRotation` above deliberately projects the course vector onto
 * the camera's right/up basis, which is orthographic: exact at the viewport
 * centre and an approximation away from it. That is the right trade for
 * aircraft, where the alternative loses continuity through a tracked orbit and
 * the contacts are far enough away for the error to be small.
 *
 * It is the wrong trade for street-level vehicles. A probe with a real Cesium
 * camera at 600 m and −45° pitch, on a northbound contact 350 m right of
 * centre, put the orthographic answer at 0° where the true screen direction of
 * travel was 22.5°. At that pitch and that range the vehicles fill the frame
 * away from the centre, and every one of them points visibly wrong.
 *
 * So this projects two nearby world points through the actual view-projection
 * and reads the angle between them on screen. When either point cannot be
 * projected — behind the camera, off the frustum, degenerate — it falls back to
 * the camera-basis answer rather than inventing one.
 *
 * @param {Cesium.Scene} scene The scene (projection source).
 * @param {Cesium.Cartesian3} position Entity world position.
 * @param {number} courseDeg Course in degrees clockwise from north.
 * @param {number|null} previous Rotation to keep when projection is unavailable.
 * @returns {number|null} Rotation in radians, or the fallback.
 */
export function perspectiveProjectedRotation(
  scene,
  position,
  courseDeg,
  previous = null,
) {
  if (!scene?.camera || !position || !Number.isFinite(courseDeg)) {
    return previous;
  }
  const courseRad = Cesium.Math.toRadians(courseDeg);
  Cesium.Cartesian3.fromElements(
    Math.sin(courseRad) * NEAR_PROBE_M,
    Math.cos(courseRad) * NEAR_PROBE_M,
    0,
    _scratchForward,
  );
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(
    position,
    Cesium.Ellipsoid.WGS84,
    _scratchEnu,
  );
  Cesium.Matrix4.multiplyByPointAsVector(
    enu,
    _scratchForward,
    _scratchWorldForward,
  );
  Cesium.Cartesian3.add(position, _scratchWorldForward, _scratchProbe);

  const at = Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    position,
    _scratchWindowAt,
  );
  const ahead = Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    _scratchProbe,
    _scratchWindowAhead,
  );
  if (!at || !ahead) {
    return screenProjectedRotation(scene, position, courseDeg, previous);
  }
  const dx = ahead.x - at.x;
  const dy = ahead.y - at.y;
  const separation = Math.hypot(dx, dy);
  // Window y grows downward; rotation 0 = icon pointing screen-up.
  const exact = Math.atan2(-dx, -dy);
  if (separation >= PERSPECTIVE_BLEND_MAX_PX) return exact;
  // Below a pixel or so of separation the exact answer is dominated by
  // projection noise, and above it the camera-basis answer is the wrong one
  // by up to twenty-odd degrees. A hard cutoff between the two flipped a
  // sprite by 23° for a 20 m change of camera altitude; the two answers are
  // blended across the band instead, the short way round, so the rotation is
  // continuous through it.
  const basis = screenProjectedRotation(scene, position, courseDeg, previous);
  if (!Number.isFinite(basis)) return exact;
  if (separation <= PERSPECTIVE_BLEND_MIN_PX) return basis;
  const weight =
    (separation - PERSPECTIVE_BLEND_MIN_PX) /
    (PERSPECTIVE_BLEND_MAX_PX - PERSPECTIVE_BLEND_MIN_PX);
  const delta = Math.atan2(Math.sin(exact - basis), Math.cos(exact - basis));
  return basis + delta * weight;
}

/**
 * Probe separations (px) between which the exact and camera-basis answers
 * are blended. At or below the floor the camera-basis answer is used alone;
 * at or above the ceiling the exact one.
 */
export const PERSPECTIVE_BLEND_MIN_PX = 0.5;
export const PERSPECTIVE_BLEND_MAX_PX = 3;

/** Exported for tests: how far ahead the exact projection probes. */
export const PERSPECTIVE_PROBE_M = NEAR_PROBE_M;
