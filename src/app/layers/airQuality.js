import { rendererFor } from './renderers.js';
import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import { overlayHost } from './overlayHost.js';
/**
 * Wire air-quality readings to the application overlay host; the station
 * discs are the engine's renderer from the manifest (render/display.js on
 * every engine).
 */
export function createApplicationAirQuality(options) {
  return createAirQualityLayer({
    overlayHost,
    rendererFactory: ({ engine }) => rendererFor('air-quality', engine),
    ...options,
  });
}
