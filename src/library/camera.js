/**
 * "Zoom to layer" for Data Library layers. Callers run this inside the
 * shell's immediate navigation (`runImmediateNavigation('layer', …)`), so
 * Cockpit can refuse it and the current follow owner is released first.
 */
import * as Cesium from 'cesium';
import { cancelCameraArrival } from '../data/cameraArrival.js';
import { isWorldScale, padExtent } from './extent.js';

/** Camera height for a world-scale layer: the whole globe in view. */
const WORLD_HEIGHT_M = 20_000_000;
/** Where a view-bounded zoom lands, as a share of the layer's altitude. */
const VIEW_LANDING_FRACTION = 0.6;

/**
 * Fly the camera to frame an extent.
 * @param {object} viewer
 * @param {{ west: number, south: number, east: number, north: number, maxAltitudeM?: number }} extent
 *   `maxAltitudeM` marks a view-bounded layer's limit.
 * @param {{ cesium?: object, reducedMotion?: boolean }} [options]
 * @returns {boolean} Whether a flight started.
 */
export function flyToLibraryExtent(
  viewer,
  extent,
  {
    cesium = Cesium,
    reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
      ?.matches === true,
  } = {},
) {
  if (!viewer?.camera?.flyTo || !extent) return false;
  cancelCameraArrival(viewer);
  const box = padExtent(extent);
  const duration = reducedMotion ? 0 : 1.6;
  // A view-bounded layer loads only below its altitude: land straight above
  // its sample area, low enough for the layer to load.
  if (Number.isFinite(extent.maxAltitudeM)) {
    viewer.camera.flyTo({
      destination: cesium.Cartesian3.fromDegrees(
        (extent.west + extent.east) / 2,
        (extent.south + extent.north) / 2,
        extent.maxAltitudeM * VIEW_LANDING_FRACTION,
      ),
      duration,
    });
    return true;
  }
  if (isWorldScale(box)) {
    const lon = (box.west + box.east) / 2;
    const lat = (box.south + box.north) / 2;
    viewer.camera.flyTo({
      destination: cesium.Cartesian3.fromDegrees(
        lon > 180 ? lon - 360 : lon,
        lat,
        WORLD_HEIGHT_M,
      ),
      duration,
    });
    return true;
  }
  // Cesium reads west > east as a box crossing the antimeridian.
  const wrap = (lon) => (lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon);
  viewer.camera.flyTo({
    destination: cesium.Rectangle.fromDegrees(
      wrap(box.west),
      box.south,
      wrap(box.east),
      box.north,
    ),
    duration,
  });
  return true;
}
