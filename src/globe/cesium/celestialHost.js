// Compatibility for callers that still construct the ring on a bare viewer.
import { flyCelestialViewer, projectCelestialPoint } from './celestial.js';

export function celestialHost(viewer) {
  return {
    host: { container: viewer.container, canvas: viewer.scene.canvas },
    frames: { postRender: viewer.scene.postRender },
    camera: {
      pose: () => ({
        position: viewer.camera.positionWC,
        cartographic: viewer.camera.positionCartographic,
        direction: viewer.camera.directionWC,
        up: viewer.camera.upWC,
        right: viewer.camera.rightWC,
        heading: viewer.camera.heading,
        fovy: viewer.camera.frustum?.fovy,
      }),
      flyTo: (options) => flyCelestialViewer(viewer, options),
    },
    projector: {
      worldToWindow: (position, result) =>
        projectCelestialPoint(viewer.scene, position, result),
    },
    render: { request: () => viewer.scene.requestRender?.() },
  };
}
