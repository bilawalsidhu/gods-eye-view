// GlobeProjector on a Cesium scene.

import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { horizonEllipsoidRadii } from '../contract.js';

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
  const { scene, camera } = viewer;
  const scratchWindow = new Cesium.Cartesian2();
  const scratchMatrix = new Cesium.Matrix4();
  const occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84);
  // The occluder is re-aimed only when the camera has moved: horizonVisible
  // runs per label per frame.
  let occluderX = Number.NaN;
  let occluderY = Number.NaN;
  let occluderZ = Number.NaN;

  let custom = null;
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
    horizonVisible(position, options) {
      const { positionWC } = camera;
      const radii = horizonEllipsoidRadii(options);
      if (radii) {
        if (
          !custom ||
          custom.radii.x !== radii.x ||
          custom.radii.y !== radii.y ||
          custom.radii.z !== radii.z
        )
          custom = {
            radii: { ...radii },
            occluder: new Cesium.EllipsoidalOccluder(
              new Cesium.Ellipsoid(radii.x, radii.y, radii.z),
            ),
          };
        custom.occluder.cameraPosition = positionWC;
        return custom.occluder.isPointVisible(position);
      }
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
