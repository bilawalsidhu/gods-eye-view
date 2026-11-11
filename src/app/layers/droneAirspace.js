import { overlayHost } from './overlayHost.js';
import { createDroneAirspaceLayer } from '../../layers/droneAirspace/index.js';
import { rendererFor } from './renderers.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/**
 * Wire FAA special-use airspace into the application catalog; the zones are
 * the engine's renderer from the manifest (render/display.js on every
 * engine).
 */
export function createApplicationDroneAirspace(options) {
  return createDroneAirspaceLayer({
    overlayHost: overlayHost,
    rendererFactory: ({ engine }) => rendererFor('drone-airspace', engine),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
