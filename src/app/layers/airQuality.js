import { rendererFor } from './renderers.js';
import { createAirQualityCesiumRenderer } from '../../layers/airQuality/render/cesium.js';
import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire air-quality readings to the application overlay host. */
export function createApplicationAirQuality(options) {
  return createAirQualityLayer({
    overlayHost,
    createRenderer: ({ viewer, engine }) =>
      engine
        ? rendererFor('air-quality', engine, { viewer })
        : createAirQualityCesiumRenderer({ viewer }),
    ...options,
  });
}
