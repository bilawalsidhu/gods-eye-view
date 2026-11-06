/**
 * Camera ground guard: never leave an arrival buried in, or pressed against,
 * the rendered surface.
 *
 * Arrival framing is computed before the destination's tiles exist, so it has
 * to predict the ground height. `globe.getHeight()` answers nothing while the
 * globe is hidden under photoreal tiles, curated `groundElevation` presets
 * cover only a few cities, and the elevation service resolves asynchronously.
 * A missing prediction used to fall back to sea level, which buried the eye by
 * roughly the local elevation (Denver ~1,600 m; Austin ~170 m).
 *
 * After the flight lands and tiles have streamed in, this module measures the
 * rendered surface under the framed target and under the camera itself, and
 * lifts the eye if it sits below a usable clearance. Heading and pitch are
 * held, so the correction reads as the shot settling.
 */
import * as Cesium from 'cesium';
import { ownCameraArrival } from './data/cameraArrival.js';
import { heightsFor } from './queries/heights.js';
import { cameraOf } from './render/cesium/camera.js';
import { cameraFlightActive } from './render/cesium/internals.js';

/** Minimum eye height above the rendered surface for a usable view. */
export const MIN_EYE_CLEARANCE_M = 120;
/** Retries while tiles stream in; sampling fails until the mesh exists. */
const GUARD_ATTEMPTS = 8;
const GUARD_INTERVAL_MS = 600;
/** Ignore sub-metre noise rather than nudging the camera forever. */
const GUARD_EPSILON_M = 2;
/** Eye travel (m) and turn (cosine) that mean another owner moved the camera. */
const MOVED_M = 0.01;
const TURNED_COS = 1 - 1e-9;

const groundScratch = new Cesium.Cartesian3();

const probeScratch = new Cesium.Cartographic();

/**
 * Highest rendered surface across a few cells, with how many cells answered.
 * A cell whose tiles are not streamed yet contributes nothing.
 * @param {Cesium.Scene} scene Live scene.
 * @param {Array<{lat: number, lon: number}>} cells Cells to probe.
 * @returns {{heightM: number, sampled: number}} Reading.
 */
function sampleSurfaceM(scene, cells) {
  let heightM = Number.NaN;
  let sampled = 0;
  if (!scene) return { heightM, sampled };
  const heights = heightsFor(scene);
  for (const cell of cells) {
    // A miss is a cell whose tiles are not ready.
    const height = heights.now(
      Cesium.Cartographic.fromDegrees(cell.lon, cell.lat, 0, probeScratch),
    );
    if (height === null) continue;
    sampled += 1;
    heightM = Number.isFinite(heightM) ? Math.max(heightM, height) : height;
  }
  return { heightM, sampled };
}

/** The eye's ground point (height 0), its height, and which way it looks. */
function poseOf(camera) {
  const carto =
    camera?.positionWC && Cesium.Cartographic.fromCartesian(camera.positionWC);
  if (!carto || !camera.directionWC || !camera.upWC) return null;
  return {
    ground: Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude),
    height: carto.height,
    direction: Cesium.Cartesian3.clone(camera.directionWC),
    up: Cesium.Cartesian3.clone(camera.upWC),
  };
}

/**
 * Whether another owner has moved the camera off `pose`: across the ground,
 * down, or around. A pure rise is not one: Cesium's terrain collision lifts a
 * buried eye straight up as tiles load, which is the case the guard exists
 * for, so `pose` follows the highest eye seen and the guard keeps measuring.
 */
function moved(camera, pose) {
  const carto = Cesium.Cartographic.fromCartesian(camera.positionWC);
  if (!carto) return true;
  const ground = Cesium.Cartesian3.fromRadians(
    carto.longitude,
    carto.latitude,
    0,
    undefined,
    groundScratch,
  );
  if (
    Cesium.Cartesian3.distance(ground, pose.ground) > MOVED_M ||
    carto.height < pose.height - MOVED_M ||
    Cesium.Cartesian3.dot(camera.directionWC, pose.direction) < TURNED_COS ||
    Cesium.Cartesian3.dot(camera.upWC, pose.up) < TURNED_COS
  )
    return true;
  pose.height = Math.max(pose.height, carto.height);
  return false;
}

/**
 * How far the camera must rise to clear the ground, given a measured surface.
 * Pure so the policy is testable without a scene.
 * @param {number} cameraHeightM Eye height above the ellipsoid.
 * @param {number} groundHeightM Measured surface height above the ellipsoid.
 * @param {number} [clearanceM] Desired eye height above that surface.
 * @returns {number} Metres to lift; 0 when the view is already clear.
 */
export function groundClearanceDeficitM(
  cameraHeightM,
  groundHeightM,
  clearanceM = MIN_EYE_CLEARANCE_M,
) {
  if (!Number.isFinite(cameraHeightM) || !Number.isFinite(groundHeightM))
    return 0;
  const deficit = groundHeightM + clearanceM - cameraHeightM;
  return deficit > GUARD_EPSILON_M ? deficit : 0;
}

/**
 * Watch an arrival and lift the camera once the real surface can be measured.
 *
 * Stops quietly on a clear view, exhausted attempts, the user taking the
 * controls (pointer or wheel on the canvas), `isStale()` reporting that a
 * newer arrival owns the camera, or any other caller moving the camera or
 * starting a flight in the meantime: the guard only ever corrects the pose it
 * was started on.
 * @param {Cesium.Viewer} viewer Live viewer.
 * @param {{lat: number, lon: number}} at Destination being framed.
 * @param {{clearanceM?: number, attempts?: number, intervalMs?: number,
 *   isStale?: () => boolean, onLift?: (liftM: number) => void}} [options]
 * @returns {() => void} Cancel function.
 */
export function guardCameraAboveGround(viewer, at, options = {}) {
  const {
    clearanceM = MIN_EYE_CLEARANCE_M,
    attempts = GUARD_ATTEMPTS,
    intervalMs = GUARD_INTERVAL_MS,
    isStale = () => false,
    onLift = null,
  } = options;
  if (!viewer?.scene || !Number.isFinite(at?.lat) || !Number.isFinite(at?.lon))
    return () => {};

  // Without a readable pose the guard could not tell a later owner's move.
  const arrival = poseOf(viewer.camera);
  if (!arrival) return () => {};

  let timer = null;
  let done = false;
  const canvas = viewer.scene.canvas;
  const documentRef = canvas?.ownerDocument;
  const removers = [];
  let release = () => {};
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    for (const type of ['pointerdown', 'wheel'])
      canvas?.removeEventListener?.(type, stop);
    documentRef?.removeEventListener?.('keydown', stop, true);
    for (const remove of removers) remove();
    release();
  };
  release = ownCameraArrival(viewer, stop);
  const removeTracking = viewer.trackedEntityChanged?.addEventListener(stop);
  if (removeTracking) removers.push(removeTracking);
  documentRef?.addEventListener?.('keydown', stop, true);
  // A manual gesture ends the guard, as it interrupts camera motion elsewhere.
  for (const type of ['pointerdown', 'wheel'])
    canvas?.addEventListener?.(type, stop, { once: true, passive: true });

  let remaining = attempts;
  const attempt = () => {
    if (done) return;
    if (isStale() || viewer.isDestroyed?.()) return stop();
    const camera = viewer.camera;
    // Another caller owns the camera now; lifting would undo its move.
    if (cameraFlightActive(camera) || moved(camera, arrival)) return stop();
    remaining -= 1;
    const carto = camera.positionCartographic;
    // The eye must clear both the framed target and the ground beneath it.
    const below = {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
    const { heightM, sampled } = sampleSurfaceM(viewer.scene, [
      { lat: at.lat, lon: at.lon },
      below,
    ]);
    if (sampled > 0 && Number.isFinite(heightM)) {
      const deficit = groundClearanceDeficitM(
        carto.height,
        heightM,
        clearanceM,
      );
      if (deficit > 0) {
        stop();
        cameraOf(viewer).flyTo(
          Cesium.Cartesian3.fromRadians(
            carto.longitude,
            carto.latitude,
            carto.height + deficit,
          ),
          {
            orientation: {
              heading: camera.heading,
              pitch: camera.pitch,
              roll: camera.roll,
            },
            durationS: 0.9,
            easing: 'cubicInOut',
          },
        );
        try {
          onLift?.(deficit);
        } catch {
          /* observer only */
        }
      }
      // Both samples answered: the surface is measured, nothing left to wait for.
      if (sampled === 2 || deficit > 0) return stop();
    }
    if (remaining <= 0) return stop();
    timer = setTimeout(attempt, intervalMs);
  };
  timer = setTimeout(attempt, intervalMs);
  return stop;
}
