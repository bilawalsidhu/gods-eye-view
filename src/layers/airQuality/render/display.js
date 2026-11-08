// The air-quality stations on the globe contract (engine.ground,
// engine.camera), the same on every engine: one ground disc per reading,
// of the layer's marker radius, filled in its band colour at 0.35, picked
// as `air-quality:${id}`. No outline: Cesium draws none on a ground-clamped
// ellipse, so none showed on either engine.

import { rgbaFromCss } from '../../shared/color.js';

const SET_ID = 'air-quality';
const FILL_ALPHA = 0.35;

/** What a pick of a station disc returns. */
export const airQualityPickId = (reading) => `air-quality:${reading.id}`;

/**
 * The station discs: `{ viewRectangle, setVisible, replace(readings,
 * radiusM), destroy }`. viewRectangle() is the camera's (radians), or
 * undefined when the globe is out of view.
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 */
export function createAirQualityDisplay(engine) {
  const set = engine.ground.createSet({
    id: SET_ID,
    kind: 'disc',
    pickable: true,
  });
  set.show(false);
  let destroyed = false;
  return {
    viewRectangle: () =>
      destroyed ? undefined : engine.camera.viewRectangle(),
    setVisible(visible) {
      if (!destroyed) set.show(visible);
    },
    replace(readings, radiusM) {
      if (destroyed) return;
      set.replace(
        readings.map((reading) => ({
          center: [reading.lon, reading.lat],
          radiusM,
          fill: rgbaFromCss(reading.color).withAlpha(FILL_ALPHA).rgba(),
          pickId: airQualityPickId(reading),
        })),
      );
      set.commit();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      set.destroy();
    },
  };
}
