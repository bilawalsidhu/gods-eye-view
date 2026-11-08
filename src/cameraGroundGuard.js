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
import { onFollowChanged } from './data/followed.js';
import { ownCameraArrival } from './data/cameraArrival.js';
import { distance, dot, fromDegrees, toLonLatH } from './geo/index.js';
import { heightsOf } from './queries/heights.js';
import { canvasOf, findCamera } from './render/rendererOf.js';

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

/**
 * Highest rendered surface across a few cells, with how many cells answered.
 * A cell whose tiles are not streamed yet contributes nothing.
 * @param {import('./queries/heights.js').HeightService|null} heights The
 *   scene's height service.
 * @param {Array<{lat: number, lon: number}>} cells Cells to probe.
 * @returns {{heightM: number, sampled: number}} Reading.
 */
function sampleSurfaceM(heights, cells) {
  let heightM = Number.NaN;
  let sampled = 0;
  if (!heights) return { heightM, sampled };
  for (const cell of cells) {
    // A miss is a cell whose tiles are not ready.
    const height = heights.now(cell);
    if (!Number.isFinite(height)) continue;
    sampled += 1;
    heightM = Number.isFinite(heightM) ? Math.max(heightM, height) : height;
  }
  return { heightM, sampled };
}

/**
 * The eye as the camera port poses it: where it is (from its position) and
 * which way it looks; null when the pose cannot be read.
 */
function eyeOf(camera) {
  try {
    const pose = camera?.pose();
    const at = pose?.position && toLonLatH(pose.position);
    if (!at || !pose.direction || !pose.up) return null;
    return { ...pose, lon: at.lon, lat: at.lat, height: at.height };
  } catch {
    return null;
  }
}

/** The eye's ground point (height 0), its height, and which way it looks. */
function poseOf(eye) {
  if (!eye) return null;
  return {
    ground: fromDegrees(eye.lon, eye.lat),
    height: eye.height,
    direction: { ...eye.direction },
    up: { ...eye.up },
  };
}

/**
 * Whether another owner has moved the camera off `pose`: across the ground,
 * down, or around. A pure rise is not one: the renderer's terrain collision
 * lifts a buried eye straight up as tiles load, which is the case the guard
 * exists for, so `pose` follows the highest eye seen and the guard keeps
 * measuring.
 */
function moved(now, pose) {
  if (!now) return true;
  const ground = fromDegrees(now.lon, now.lat);
  if (
    distance(ground, pose.ground) > MOVED_M ||
    now.height < pose.height - MOVED_M ||
    dot(now.direction, pose.direction) < TURNED_COS ||
    dot(now.up, pose.up) < TURNED_COS
  )
    return true;
  pose.height = Math.max(pose.height, now.height);
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
 * @param {object} viewer Live viewer.
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
  if (!viewer || !Number.isFinite(at?.lat) || !Number.isFinite(at?.lon))
    return () => {};

  // Without a readable pose the guard could not tell a later owner's move.
  const arrival = poseOf(eyeOf(findCamera(viewer)));
  if (!arrival) return () => {};

  let timer = null;
  let done = false;
  const canvas = canvasOf(viewer);
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
  removers.push(onFollowChanged(viewer, stop));
  documentRef?.addEventListener?.('keydown', stop, true);
  // A manual gesture ends the guard, as it interrupts camera motion elsewhere.
  for (const type of ['pointerdown', 'wheel'])
    canvas?.addEventListener?.(type, stop, { once: true, passive: true });

  let remaining = attempts;
  const attempt = () => {
    if (done) return;
    if (isStale() || viewer.isDestroyed?.()) return stop();
    const camera = findCamera(viewer);
    const now = eyeOf(camera);
    // Another caller owns the camera now; lifting would undo its move.
    if (!camera || camera.flying || moved(now, arrival)) return stop();
    remaining -= 1;
    // The eye must clear both the framed target and the ground beneath it.
    const below = { lat: now.lat, lon: now.lon };
    const { heightM, sampled } = sampleSurfaceM(
      viewer ? heightsOf(viewer) : null,
      [{ lat: at.lat, lon: at.lon }, below],
    );
    if (sampled > 0 && Number.isFinite(heightM)) {
      const deficit = groundClearanceDeficitM(now.height, heightM, clearanceM);
      if (deficit > 0) {
        stop();
        camera.flyTo(
          { lon: now.lon, lat: now.lat, height: now.height + deficit },
          {
            orientation: {
              heading: now.heading,
              pitch: now.pitch,
              roll: now.roll,
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
