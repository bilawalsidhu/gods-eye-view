import { createDroneAirspaceLayer } from '../../layers/droneAirspace/index.js';
import * as picking from '../../data/pickRegistry.js';
import { overlayHost } from './overlayHost.js';

/** Wire FAA special-use airspace into the application catalog. */
export function createApplicationDroneAirspace(options) {
  return createDroneAirspaceLayer({
    overlayHost,
    picking,
    ...options,
  });
}
