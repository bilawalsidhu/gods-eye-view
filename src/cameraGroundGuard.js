/**
 * Camera ground guard: never leave the eye buried in, or pressed against, terrain.
 *
 * Arrival framing is computed BEFORE the destination's tiles exist, so it has to
 * guess the ground height. Every available guess is unreliable:
 *   - `globe.getHeight()` is structurally dead here (the globe is hidden under the
 *     photorealistic tileset, and no terrain provider is installed),
 *   - the curated `groundElevation` presets cover only a handful of cities,
 *   - and the DEM service resolves asynchronously. Measured cold at one test site
 *     it came back ~134 m below the rendered surface, often not before the flight.
 *
 * Guessing low is not a cosmetic error. The fallback defaults to sea level, so the
 * eye ends up buried by roughly the local elevation: ~1,609 m over Denver, ~2,240 m
 * over Mexico City. Both render a black frame.
 *
 * So this module does not guess. After the flight lands, once tiles are actually
 * streamed in and `scene.sampleHeight` is trustworthy, it measures the surface the
 * user is really looking at and lifts the camera if it is below a usable clearance.
 * Ground truth beats every prediction, and it is only available afterwards.
 */
import * as Cesium from 'cesium';
import { probeMeshFloorM } from './cameraVerbs.js';

/** Minimum eye height above the rendered surface for a usable view. */
export const MIN_EYE_CLEARANCE_M = 120;
/** Retries while tiles stream in; sampling fails until the mesh exists. */
export const GUARD_ATTEMPTS = 6;
export const GUARD_INTERVAL_MS = 700;
/** Ignore sub-metre noise rather than nudging the camera forever. */
const GUARD_EPSILON_M = 2;

/**
 * How far the camera must rise to clear the ground, given a measured surface.
 * Pure so the policy is testable without a scene.
 *
 * @param {number} cameraHeightM eye height above the ellipsoid.
 * @param {number} groundHeightM measured surface height above the ellipsoid.
 * @param {number} clearanceM desired eye height above that surface.
 * @returns {number} metres to lift; 0 when the view is already clear.
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
 * Gives up quietly on: a clear view, exhausted attempts, or the user taking the
 * controls (their camera is theirs; correcting under their hands is worse than a
 * low angle they chose).
 *
 * @param {Cesium.Viewer} viewer
 * @param {{lat: number, lon: number}} at destination being framed.
 * @param {{clearanceM?: number, attempts?: number, intervalMs?: number, isStale?: () => boolean}} [options]
 * @returns {() => void} cancel function.
 */
export function guardCameraAboveGround(viewer, at, options = {}) {
  const {
    clearanceM = MIN_EYE_CLEARANCE_M,
    attempts = GUARD_ATTEMPTS,
    intervalMs = GUARD_INTERVAL_MS,
    isStale = () => false,
  } = options;

  if (!viewer?.scene || !Number.isFinite(at?.lat) || !Number.isFinite(at?.lon))
    return () => {};

  let timer = null;
  let done = false;
  const canvas = viewer.scene.canvas;

  const stop = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    for (const evt of ['pointerdown', 'wheel'])
      canvas?.removeEventListener(evt, stop);
  };

  // The user taking manual control ends the guard, matching how a manual gesture
  // already interrupts camera motions elsewhere.
  for (const evt of ['pointerdown', 'wheel']) {
    canvas?.addEventListener(evt, stop, { once: true, passive: true });
  }

  let remaining = attempts;
  const attempt = () => {
    if (done) return;
    if (isStale()) return stop();
    remaining -= 1;

    const { heightM, sampled } = probeMeshFloorM(viewer.scene, [
      { lat: at.lat, lon: at.lon },
    ]);
    if (sampled > 0 && Number.isFinite(heightM)) {
      const camera = viewer.camera;
      const carto = camera.positionCartographic;
      const deficit = groundClearanceDeficitM(
        carto.height,
        heightM,
        clearanceM,
      );
      if (deficit > 0) {
        // Rise in place, holding heading and pitch, so it reads as the shot settling
        // rather than a second flight to somewhere else.
        camera.flyTo({
          destination: Cesium.Cartesian3.fromRadians(
            carto.longitude,
            carto.latitude,
            carto.height + deficit,
          ),
          orientation: {
            heading: camera.heading,
            pitch: camera.pitch,
            roll: camera.roll,
          },
          duration: 0.9,
          easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        });
      }
      return stop(); // measured the real surface, nothing more to learn by waiting
    }

    if (remaining <= 0) return stop();
    timer = setTimeout(attempt, intervalMs);
  };

  timer = setTimeout(attempt, intervalMs);
  return stop;
}
