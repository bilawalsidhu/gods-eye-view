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
  const scratchWindow = new Cesium.Cartesian2();
  const scratchMatrix = new Cesium.Matrix4();
  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);

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
      const { camera } = scene;
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
      occluder.cameraPosition = scene.camera.positionWC;
      return occluder.isPointVisible(position);
    },
  };
  return { projector, destroy() {} };
}
