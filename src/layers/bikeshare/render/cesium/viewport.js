import * as Cesium from 'cesium';
import * as geo from '../../../../geo/index.js';
import { createViewport as createSharedViewport } from '../../viewport.js';

export function createViewport(context) {
  /**
   * Get the camera's current altitude in meters above the ellipsoid.
   * @param {Cesium.Viewer} viewer - Cesium viewer instance.
   * @returns {number} Altitude in meters, or Infinity if unavailable.
   */

  function getCameraAltitude(viewer) {
    const carto = viewer?.camera?.positionCartographic;
    return carto && Number.isFinite(carto.height) ? carto.height : Infinity;
  }

  /**
   * Determine the lat/lon the camera is currently looking at.
   * Prefers the center of the computed view rectangle; falls back to the
   * camera's own cartographic position when the rectangle is unavailable.
   * @param {Cesium.Viewer} viewer - Cesium viewer instance.
   * @returns {{ lat: number, lon: number }|null} Center coordinates in degrees, or null.
   */

  function getCameraCenterLatLon(viewer) {
    // Try view rectangle center first (more accurate for tilted views)
    const rect = viewer?.camera?.computeViewRectangle?.(
      viewer.scene.globe?.ellipsoid,
    );
    if (rect) {
      const center = Cesium.Rectangle.center(rect);
      return {
        lat: geo.math.toDegrees(center.latitude),
        lon: geo.math.toDegrees(center.longitude),
      };
    }

    // Fallback: use the camera's own position
    const carto = viewer?.camera?.positionCartographic;
    if (carto) {
      return {
        lat: geo.math.toDegrees(carto.latitude),
        lon: geo.math.toDegrees(carto.longitude),
      };
    }

    return null;
  }

  return createSharedViewport({
    ...context,
    camera: { getCameraAltitude, getCameraCenterLatLon },
  });
}
