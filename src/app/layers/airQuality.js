import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire air-quality readings to the application overlay host. */
export function createApplicationAirQuality(options) {
  return createAirQualityLayer({ overlayHost, ...options });
}
