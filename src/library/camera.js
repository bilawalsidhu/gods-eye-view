/**
 * "Zoom to layer" for Data Library layers. Callers run this inside the
 * shell's immediate navigation (`runImmediateNavigation('layer', …)`), so
 * Cockpit can refuse it and the current follow owner is released first.
 * The flight goes through the renderer's camera port.
 */
import { cancelCameraArrival } from '../data/cameraArrival.js';
import { findCamera } from '../render/rendererOf.js';
import { isWorldScale, padExtent } from './extent.js';

/** Camera height for a world-scale layer: the whole globe in view. */
const WORLD_HEIGHT_M = 20_000_000;
/** Where a view-bounded zoom lands, as a share of the layer's altitude. */
const VIEW_LANDING_FRACTION = 0.6;

/**
 * Fly the camera to frame an extent, looking straight down, north up.
 * @param {object} viewer
 * @param {{ west: number, south: number, east: number, north: number, maxAltitudeM?: number }} extent
 *   `maxAltitudeM` marks a view-bounded layer's limit.
 * @param {{ reducedMotion?: boolean }} [options]
 * @returns {boolean} Whether a flight started.
 */
export function flyToLibraryExtent(
  viewer,
  extent,
  {
    reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
      ?.matches === true,
  } = {},
) {
  const camera = findCamera(viewer);
  if (!camera?.flyTo || !extent) return false;
  cancelCameraArrival(viewer);
  const box = padExtent(extent);
  const options = { durationS: reducedMotion ? 0 : 1.6 };
  // A view-bounded layer loads only below its altitude: land straight above
  // its sample area, low enough for the layer to load.
  if (Number.isFinite(extent.maxAltitudeM)) {
    camera.flyTo(
      {
        lon: (extent.west + extent.east) / 2,
        lat: (extent.south + extent.north) / 2,
        height: extent.maxAltitudeM * VIEW_LANDING_FRACTION,
      },
      options,
    );
    return true;
  }
  if (isWorldScale(box)) {
    const lon = (box.west + box.east) / 2;
    const lat = (box.south + box.north) / 2;
    camera.flyTo(
      { lon: lon > 180 ? lon - 360 : lon, lat, height: WORLD_HEIGHT_M },
      options,
    );
    return true;
  }
  // A rectangle whose west is east of its east crosses the antimeridian.
  const wrap = (lon) => (lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon);
  camera.flyTo(
    {
      rect: {
        west: wrap(box.west),
        south: box.south,
        east: wrap(box.east),
        north: box.north,
      },
    },
    options,
  );
  return true;
}
