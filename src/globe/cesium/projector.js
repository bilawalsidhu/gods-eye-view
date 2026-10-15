// GlobeProjector on a Cesium scene.

import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ worldToWindowCoordinates?: Function }} [options] Test seam for
 *   Cesium.SceneTransforms.worldToWindowCoordinates.
 * @returns {{ projector: import('../contract.js').GlobeProjector, destroy: () => void }}
 */
export function createCesiumProjector(
  viewer,
  {
    worldToWindowCoordinates = Cesium.SceneTransforms.worldToWindowCoordinates,
  } = {},
) {
  const { scene } = viewer;
  // Viewer.camera is scene.camera; the engine reads the public alias.
  const camera = viewer.camera ?? scene.camera;
  const scratchWindow = new Cesium.Cartesian2();
  const scratchMatrix = new Cesium.Matrix4();
  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);
  // The occluder is re-aimed only when the camera has moved: horizonVisible
  // runs per label per frame.
  let occluderX = Number.NaN;
  let occluderY = Number.NaN;
  let occluderZ = Number.NaN;

  const projector = {
    worldToWindow(position, result) {
      // Cesium returns undefined in front of the near plane or behind the camera.
      const window = worldToWindowCoordinates(scene, position, scratchWindow);
      if (!window) return undefined;
      if (!result) return geo.cartesian2.create(window.x, window.y);
      result.x = window.x;
      result.y = window.y;
      return result;
    },
    // The matrix Cesium's worldToWindowCoordinates uses: frustum projection ×
    // view. x, y and w do not depend on the multi-frustum near/far planes.
    viewProjection(result = geo.matrix4.create()) {
      Cesium.Matrix4.multiply(
        camera.frustum.projectionMatrix,
        camera.viewMatrix,
        scratchMatrix,
      );
      for (let index = 0; index < 16; index++)
        result[index] = scratchMatrix[index];
      return result;
    },
    horizonVisible(position) {
      const { positionWC } = camera;
      if (
        positionWC.x !== occluderX ||
        positionWC.y !== occluderY ||
        positionWC.z !== occluderZ
      ) {
        occluder.cameraPosition = positionWC;
        occluderX = positionWC.x;
        occluderY = positionWC.y;
        occluderZ = positionWC.z;
      }
      return occluder.isPointVisible(position);
    },
  };
  return { projector, destroy() {} };
}
