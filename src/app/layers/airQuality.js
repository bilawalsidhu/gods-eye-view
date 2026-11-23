import { createAirQualityLayer } from '../../layers/airQuality/index.js';
import { overlayHost } from './overlayHost.js';
import { inputFor } from '../../input/dispatcher.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
/** Wire air-quality readings to the application overlay host, clicks and picks. */
export function createApplicationAirQuality(options) {
  return createAirQualityLayer({
    overlayHost,
    input: inputFor,
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
