import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import { overlayHost } from './overlayHost.js';
import { inputFor } from '../../input/dispatcher.js';
import { clickCard } from '../../data/pickRegistry.js';
/** Wire air-quality readings to the application overlay host and its clicks. */
export function createApplicationAirQuality(options) {
  return createAirQualityLayer({
    overlayHost,
    input: inputFor,
    clickCard,
    ...options,
  });
}
