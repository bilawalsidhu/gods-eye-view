/**
 * Sky view <-> the renderer: put the camera at the observer's eye looking
 * along (az, el), and save/restore everything Sky mode touches so "Back to
 * map" returns the camera, field of view, camera input, collision and the
 * globe's look exactly.
 *
 * Everything goes through the renderer's ports (`src/render/rendererOf.js`)
 * found from the application's scene object: the camera port for the eye, the
 * globe port for lighting, stars and the globe surface, the frame port for
 * Sky time. Everything that changes is listed in snapshotScene() and
 * snapshotCamera(); nothing else is written. Layer toggles are never touched.
 */
import { eastNorthUp, inverseFrameVector } from '../geo/frames.js';
import { heightsOf } from '../queries/heights.js';
import { findCamera, findFrame, findGlobe } from '../render/rendererOf.js';
import {
  DEG,
  azElToHeadingPitch,
  fovAngles,
  headingPitchToAzEl,
} from './skyMath.js';
import { observerEyeHeight } from './observer.js';

const copy = (v) => ({ x: v.x, y: v.y, z: v.z });

/**
 * Copy of the camera's world pose and vertical field of view, and whether it
 * was in the world frame (not orbiting a `lookAt` target).
 * @param {import('../render/contract/camera').CameraPort} camera
 */
export function snapshotCamera(camera) {
  const pose = camera?.pose();
  if (!pose) return null;
  return {
    frameIsIdentity: pose.frameIsIdentity,
    position: copy(pose.position),
    direction: copy(pose.direction),
    up: copy(pose.up),
    fovy: pose.fovy,
  };
}

/**
 * Put a snapshot back: the same world position, direction and up, and the
 * field of view back to the renderer (it follows the view's shape again).
 */
export function restoreCamera(camera, snap) {
  if (!snap || !camera) return;
  camera.setView({
    destination: copy(snap.position),
    orientation: { direction: copy(snap.direction), up: copy(snap.up) },
  });
  camera.setFov(null);
}

/**
 * The camera's vertical field of view (radians) for a Sky view. Sky's
 * `fovDeg` is the angle across the LONGER side of the canvas
 * (skyMath.frustumTangents, which the overlay projects with), while the
 * camera port holds the vertical angle, so a landscape canvas narrows it by
 * its aspect.
 * @param {number} fovDeg
 * @param {{width: number, height: number}} size Canvas size, CSS pixels.
 */
export function skyFovy(fovDeg, { width, height }) {
  return fovAngles(fovDeg, width, height).verticalDeg * DEG;
}

/**
 * The camera at the observer's eye looking along the view, with the field of
 * view the overlay draws with. `size` is the canvas size; without it the
 * camera's own aspect ratio is used.
 */
export function applySkyCamera(camera, observer, view, size) {
  const orientation = azElToHeadingPitch(view.azDeg, view.elDeg, view.rollDeg);
  // The eye is placed in the world frame; leave a `lookAt` orbit first.
  const pose = camera.pose();
  if (!pose.frameIsIdentity) camera.release();
  const aspect = Number.isFinite(pose.aspectRatio) ? pose.aspectRatio : 1;
  const canvas =
    size?.width > 0 && size?.height > 0 ? size : { width: aspect, height: 1 };
  camera.setView({
    destination: {
      lon: observer.lonDeg,
      lat: observer.latDeg,
      height: observerEyeHeight(observer),
    },
    orientation,
  });
  const vertical = skyFovy(view.fovDeg, canvas);
  camera.setFov({ vertical });
  return vertical;
}

/**
 * az/el from the camera's heading and pitch. Within ~2 deg of the zenith the
 * heading reads heading + 180 (it comes from the up vector there); use
 * worldDirectionToAzEl for the true look direction.
 */
export function readCameraAzEl(camera) {
  const { heading, pitch } = camera.pose();
  return headingPitchToAzEl(heading, pitch);
}

/**
 * Independent check: az/el of a world direction at a world position via the
 * ENU frame (not via the camera's heading), so tests do not just read back
 * inputs. Both are ECEF `{x, y, z}`.
 */
export function worldDirectionToAzEl(position, direction) {
  const d = inverseFrameVector(eastNorthUp(position), direction);
  const horizontal = Math.hypot(d.x, d.y);
  let az = Math.atan2(d.x, d.y) / DEG;
  if (az < 0) az += 360;
  return { azDeg: az, elDeg: Math.atan2(d.z, horizontal) / DEG };
}

/**
 * Height (m) above which the camera is out of reach of terrain collision: the
 * renderer's own ceiling for it (15 km), and above it nothing is sampled.
 */
export const COLLISION_CEILING_M = 15_000;

/**
 * True when putting the saved collision mode back would let the renderer lift
 * this camera, now or once the surface under it has loaded. Writing the mode
 * itself does not move the camera.
 *
 * Safe: at or above `ground + minDistance`, or at or above the ceiling. Not
 * safe: under that floor, or under the ceiling while the ground height or the
 * camera height is still unknown.
 * @param {object} host The scene object.
 * @param {'none'|'terrain'|'tiles'|'both'|undefined} saved Mode about to be restored.
 * @returns {boolean}
 */
export function collisionRestoreLifts(host, saved) {
  if (!saved || saved === 'none') return false;
  const camera = findCamera(host);
  if (!camera) return false;
  const pose = camera.pose();
  if (!Number.isFinite(pose.height)) return true;
  if (pose.height >= COLLISION_CEILING_M) return false;
  const ground = heightsOf(host).now(
    { lon: pose.lon, lat: pose.lat },
    { against: saved === 'terrain' ? 'terrain' : 'surface' },
  );
  if (!Number.isFinite(ground)) return true;
  const minZoom = Number.isFinite(camera.controls.minDistance)
    ? camera.controls.minDistance
    : 1;
  return pose.height < ground + minZoom;
}

/** What Sky mode may change in the scene: the globe's look and collision. */
export function snapshotScene(host) {
  const globe = findGlobe(host);
  const camera = findCamera(host);
  return {
    sky: globe ? { ...globe.sky.get() } : null,
    // A renderer that cannot say whether the surface is shown draws it.
    globeVisible: globe?.isGlobeVisible?.() ?? true,
    collision: camera?.controls.collision,
  };
}

/**
 * Take the camera for Sky: user camera input is suspended (a counted hold,
 * given back by the returned function) and terrain collision is off, because
 * the renderer would otherwise lift a ground-level eye onto whatever is under
 * it (seen: +138 m in downtown Houston on the smoke test); the observer
 * height is ours to set. The collision mode itself comes back through
 * restoreScene().
 * @returns {() => void} Gives the camera input back.
 */
export function takeSkyControls(host) {
  const camera = findCamera(host);
  if (!camera) return () => {};
  const release = camera.controls.suspend('sky-view');
  camera.controls.collision = 'none';
  return release;
}

/**
 * Put every saved setting back. `deferCollision`: a handoff that kept a camera
 * under the terrain floor leaves collision off and puts it back itself once
 * that camera is safe.
 */
export function restoreScene(host, snap, { deferCollision = false } = {}) {
  if (!snap) return;
  const globe = findGlobe(host);
  if (globe) {
    globe.setGlobeVisible(snap.globeVisible);
    if (snap.sky) globe.sky.set(snap.sky);
  }
  // A normal restore writes collision with the rest. A handoff that kept a
  // camera under the terrain floor passes deferCollision.
  const camera = findCamera(host);
  if (camera && !deferCollision && snap.collision !== undefined)
    camera.controls.collision = snap.collision;
  findFrame(host)?.requestRender('sky-exit');
}

/**
 * Scene display for Sky mode. Real horizon: the globe as it was (it forms the
 * silhouette). Flat horizon: hide the globe surface so the overlay paints a
 * clean ground. Lighting follows the Sun so the atmosphere goes blue -> dusk
 * -> dark with Sky time (spike: with globe lighting off the atmosphere is lit
 * from the camera = always day). The star sky shows only when `skyBox`
 * (skyMath.skyBoxVisible). The atmosphere is left as it was.
 */
export function applySkyScene(
  host,
  snap,
  { flatHorizon = false, skyBox = false } = {},
) {
  const globe = findGlobe(host);
  if (globe) {
    // Written only on change: this runs every frame while Sky time plays.
    const visible = flatHorizon ? false : snap.globeVisible;
    if (globe.isGlobeVisible?.() !== visible) globe.setGlobeVisible(visible);
    const sky = globe.sky.get();
    const stars = Boolean(skyBox);
    if (sky.lighting !== true || sky.stars !== stars)
      globe.sky.set({ lighting: true, stars });
  }
  findFrame(host)?.requestRender('sky');
}

/**
 * Whether Sky mode leaves third-party map tiles on screen (imagery and
 * terrain on the globe, Google / buildings 3D tiles), i.e. whether their
 * attribution must stay visible in Clear view. The renderer's ports can hide
 * the globe surface but not 3D tiles, so under the flat horizon the tiles may
 * still be drawn: only a hidden globe with nothing else to show would let
 * attribution go, and nothing says that. So the answer is always true.
 * @param {object|null} _snap
 * @param {{flatHorizon?: boolean}} [_options]
 */
export function skyTilesShown(_snap, _options) {
  return true;
}

/**
 * Own Sky time on the frame loop. The application sets scene time each frame
 * in a `preUpdate` listener; this one is added after it, so it runs after it
 * and Sky's time is the time each frame draws. Off() hands time back: the
 * application's listener then sets it again by itself, so nothing is saved
 * or restored.
 * @param {object} host The scene object.
 * @param {() => number} timeMs Sky time now, epoch ms.
 * @returns {() => void} Stops stamping Sky time.
 */
export function holdSkyTime(host, timeMs) {
  const frame = findFrame(host);
  if (!frame) return () => {};
  return frame.on('preUpdate', () => {
    const t = timeMs();
    if (Number.isFinite(t)) frame.setTime(t);
  });
}

/** Set scene time to Sky time now (between frames it asks for a frame). */
export function applySkyTime(host, timeMs) {
  if (!Number.isFinite(timeMs)) return;
  findFrame(host)?.setTime(timeMs);
}
