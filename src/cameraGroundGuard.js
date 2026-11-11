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
import { readSurface } from './globe/surfacePlacement.js';
import * as geo from './geo/index.js';
import { ownCameraArrival } from './data/cameraArrival.js';

/** Minimum eye height above the rendered surface for a usable view. */
export const MIN_EYE_CLEARANCE_M = 120;
/** Retries while tiles stream in; sampling fails until the mesh exists. */
const GUARD_ATTEMPTS = 8;
const GUARD_INTERVAL_MS = 600;
/** Ignore sub-metre noise rather than nudging the camera forever. */
const GUARD_EPSILON_M = 2;

const probeScratch = geo.cartographic.create();

/**
 * Highest rendered surface across a few cells, with how many cells answered.
 * A cell whose tiles are not streamed yet contributes nothing.
 * @param {import('./globe/contract.js').GlobeEngine} engine Live engine.
 * @param {Array<{lat: number, lon: number}>} cells Cells to probe.
 * @returns {{heightM: number, sampled: number}} Reading.
 */
function sampleSurfaceM(engine, cells) {
  let heightM = Number.NaN;
  let sampled = 0;
  for (const cell of cells) {
    try {
      const height = readSurface(
        engine,
        geo.cartographic.fromDegrees(cell.lon, cell.lat, 0, probeScratch),
        { prefer: 'scene' },
      );
      if (!Number.isFinite(height)) continue;
      sampled += 1;
      heightM = Number.isFinite(heightM) ? Math.max(heightM, height) : height;
    } catch {
      /* tiles not ready for this cell */
    }
  }
  return { heightM, sampled };
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
 * controls (pointer or wheel on the canvas, a key), any camera command
 * (`camera.commanded`: a flight, setView, lookAt, cancelFlight or, on
 * Cesium, a new tracked entity), or `isStale()` reporting that a newer
 * arrival owns the camera.
 * @param {import('./globe/contract.js').GlobeEngine | null} engine
 * @param {{lat: number, lon: number}} at Destination being framed.
 * @param {{clearanceM?: number, attempts?: number, intervalMs?: number,
 *   isStale?: () => boolean, onLift?: (liftM: number) => void}} [options]
 * @returns {() => void} Cancel function.
 */
export function guardCameraAboveGround(engine, at, options = {}) {
  const {
    clearanceM = MIN_EYE_CLEARANCE_M,
    attempts = GUARD_ATTEMPTS,
    intervalMs = GUARD_INTERVAL_MS,
    isStale = () => false,
    onLift = null,
  } = options;
  if (!engine || !Number.isFinite(at?.lat) || !Number.isFinite(at?.lon))
    return () => {};

  let timer = null;
  let done = false;
  const canvas = engine.host.canvas;
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
  release = ownCameraArrival(engine, stop);
  // Any new camera owner (including duration-zero flights and, on Cesium,
  // direct viewer-camera calls and tracking) yields the guard before it moves
  // the eye.
  removers.push(engine.camera.commanded.addEventListener(stop));
  documentRef?.addEventListener?.('keydown', stop, true);
  // A manual gesture ends the guard, as it interrupts camera motion elsewhere.
  for (const type of ['pointerdown', 'wheel'])
    canvas?.addEventListener?.(type, stop, { once: true, passive: true });

  let remaining = attempts;
  const attempt = () => {
    if (done) return;
    if (isStale() || engine.isDestroyed()) return stop();
    remaining -= 1;
    const { camera } = engine;
    const pose = camera.pose();
    const carto = pose.cartographic;
    // The eye must clear both the framed target and the ground beneath it.
    const below = {
      lat: geo.math.toDegrees(carto.latitude),
      lon: geo.math.toDegrees(carto.longitude),
    };
    const { heightM, sampled } = sampleSurfaceM(engine, [
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
        camera.flyTo({
          destination: geo.cartesian3.fromRadians(
            carto.longitude,
            carto.latitude,
            carto.height + deficit,
          ),
          orientation: {
            heading: pose.heading,
            pitch: pose.pitch,
            roll: pose.roll,
          },
          duration: 0.9,
          easing: 'cubicInOut',
        });
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
