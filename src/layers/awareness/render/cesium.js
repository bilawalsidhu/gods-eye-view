import { BoundingSphere, Color } from 'cesium';
import { AWARENESS_RADIUS_M } from '../../../data/militaryAwarenessEngine.js';
import { CONTEXT_RIM_HEIGHT_M } from '../policy.js';

export function createAwarenessCesiumRenderer(viewer) {
  return {
    container: viewer.container,
    get canvas() {
      return viewer.scene?.canvas;
    },
    get camera() {
      return viewer.camera;
    },
    get trackedEntity() {
      return viewer.trackedEntity;
    },
    onFrame: (run) => viewer.scene.preRender.addEventListener(run),
    frameContact: (center, radius, duration) =>
      viewer.camera.flyToBoundingSphere(new BoundingSphere(center, radius), {
        duration,
      }),
    createRim(center) {
      const entity = viewer.entities.add({
        position: center,
        ellipse: {
          semiMajorAxis: AWARENESS_RADIUS_M,
          semiMinorAxis: AWARENESS_RADIUS_M,
          fill: false,
          outline: true,
          outlineColor: Color.fromCssColorString('#62b5ff').withAlpha(0.72),
          height: CONTEXT_RIM_HEIGHT_M,
        },
      });
      return {
        move: (next) => entity.position.setValue(next),
        destroy: () => viewer.entities.remove(entity),
      };
    },
  };
}
