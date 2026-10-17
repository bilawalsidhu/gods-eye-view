import * as Cesium from 'cesium';
import { viewAreaRadiusKm } from './viewArea.js';

/**
 * The area a viewer is looking at, as `{ lat, lon, radiusKm }`: centered on
 * the point in the middle of the screen (or below the camera when the middle
 * shows sky), sized by the camera's height. Null for a view that wants every
 * vessel.
 */
export function vesselViewArea(viewer) {
  const camera = viewer?.camera;
  const scene = viewer?.scene;
  const height = camera?.positionCartographic?.height;
  const radiusKm = viewAreaRadiusKm(height);
  if (radiusKm == null) return null;
  let center = camera.positionCartographic;
  const canvas = scene?.canvas;
  if (canvas?.clientWidth && canvas?.clientHeight) {
    try {
      const hit = camera.pickEllipsoid(
        new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
        scene.globe?.ellipsoid,
      );
      if (hit) center = Cesium.Cartographic.fromCartesian(hit);
    } catch {
      /* the camera position stands in */
    }
  }
  const lat = Cesium.Math.toDegrees(center.latitude);
  const lon = Cesium.Math.toDegrees(center.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, radiusKm };
}
