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

/**
 * Resolve once no provider of an air-quality layer is still asking: an
 * update resolves on the first provider's answer, the others land later.
 */
export async function airQualitySettled(layer, { turns = 200 } = {}) {
  for (let turn = 0; turn < turns; turn++) {
    if (!layer.getProviderStates().some((state) => state.status === 'loading'))
      return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('air-quality providers did not settle');
}
