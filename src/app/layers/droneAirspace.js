import { createDroneAirspaceLayer } from '../../layers/droneAirspace/index.js';
import { rendererFor } from './renderers.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/**
 * Wire FAA special-use airspace into the application catalog; the zones are
 * the engine's renderer from the registry (render/display.js on every
 * engine).
 */
export function createApplicationDroneAirspace(options) {
  return createDroneAirspaceLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    createRenderer: ({ engine }) => rendererFor('drone-airspace', engine),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
