/**
 * Camera, frame and query ports over a Cesium-shaped viewer double, for the
 * screen-space overlay's tests: what the overlay asks of a renderer, read
 * live from the double (`viewer.camera.positionWC`, `positionCartographic`,
 * `viewMatrix`, `frustum.projectionMatrix`, `moveEnd`; `viewer.scene`'s
 * `postRender` and `requestRender`), so a test moves the camera by editing
 * the double. The horizon test is the Cesium query port's own; the rest
 * allocates nothing per call once warm, so the overlay's allocation probe
 * measures the overlay and the occlusion test it runs in the app.
 */
import * as Cesium from 'cesium';
import { createCesiumQuery } from '../render/cesium/query.js';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeSceneFrame } from './fakeCesiumScene.mjs';

/**
 * Bind the ports to `viewer`.
 * @param {object} viewer
 * @returns {{camera: object, frame: object, query: object, unbind: () => void}}
 */
export function bindOverlayPorts(viewer) {
  const pose = {
    position: { x: 0, y: 0, z: 0 },
    height: Number.NaN,
  };
  const matrices = {
    view: new Float64Array(16),
    projection: new Float64Array(16),
  };
  const camera = {
    pose() {
      const c = viewer.camera;
      pose.position.x = c.positionWC.x;
      pose.position.y = c.positionWC.y;
      pose.position.z = c.positionWC.z;
      pose.height = c.positionCartographic?.height ?? Number.NaN;
      return pose;
    },
    matrices() {
      Cesium.Matrix4.toArray(viewer.camera.viewMatrix, matrices.view);
      Cesium.Matrix4.toArray(
        viewer.camera.frustum.projectionMatrix,
        matrices.projection,
      );
      return matrices;
    },
    on(event, cb) {
      const source = viewer.camera?.[event];
      const off = source?.addEventListener?.(cb);
      return typeof off === 'function'
        ? off
        : () => source?.removeEventListener?.(cb);
    },
  };
  const frame = fakeSceneFrame(viewer);
  // The Cesium query port's own horizon test, so the allocation probe
  // measures what the app runs.
  const cesiumQuery = createCesiumQuery({
    scene: viewer.scene ?? {},
    camera: {
      get positionWC() {
        return viewer.camera.positionWC;
      },
    },
    draw: { sets: new Map() },
    capabilities: new Set(),
  });
  const query = {
    isOccluded: (position) => cesiumQuery.isOccluded(position),
  };
  const unbind = bindRenderer(viewer, { camera, frame, query });
  return { camera, frame, query, unbind };
}
