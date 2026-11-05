import { BoundingSphere } from 'cesium';

/**
 * The awareness layer's view of a Cesium globe. Its range ring, pulse disc
 * and echoes are Cesium primitives (rendering.js), built on `viewer`.
 */
export function createAwarenessCesiumRenderer(viewer) {
  return {
    viewer,
    container: viewer.container,
    get canvas() {
      return viewer.canvas ?? viewer.scene?.canvas;
    },
    get camera() {
      return viewer.camera;
    },
    get trackedEntity() {
      return viewer.trackedEntity;
    },
    // Off while another owner (the cockpit, a gizmo drag, a drawing tool)
    // has the camera: the user's gesture moves nothing then.
    cameraInputsEnabled: () =>
      viewer.scene?.screenSpaceCameraController?.enableInputs !== false,
    onFrame: (run) => viewer.scene.preRender.addEventListener(run),
    frameContact: (center, radius, duration) =>
      viewer.camera.flyToBoundingSphere(new BoundingSphere(center, radius), {
        duration,
      }),
  };
}
