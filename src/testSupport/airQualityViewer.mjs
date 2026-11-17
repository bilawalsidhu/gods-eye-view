import { bindFakeDraw } from './fakeDrawPort.mjs';
import { horizonFrom } from '../geo/horizon.js';

/** Bind the renderer ports used by observation-layer test fixtures. */
export function initAirQualityTestLayer(layer, fixture = {}) {
  const camera = fixture.camera;
  const horizon = camera?.positionWC ? horizonFrom(camera.positionWC) : null;
  const viewer = {};
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      viewRectangle() {
        const rectangle = camera?.computeViewRectangle?.();
        return rectangle
          ? Object.fromEntries(
              Object.entries(rectangle).map(([key, radians]) => [
                key,
                (radians * 180) / Math.PI,
              ]),
            )
          : null;
      },
      on: (event, listener) =>
        camera?.[event]?.addEventListener(listener) ?? (() => {}),
    },
    query: {
      isOccluded: (position) =>
        horizon ? !horizon.isPointVisible(position) : false,
    },
  });
  layer.init(viewer);
  return draw;
}
