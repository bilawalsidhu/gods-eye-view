import { createDroneAirspaceLayer } from '../../layers/droneAirspace/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';

/** Wire FAA special-use airspace into the application catalog. */
export function createApplicationDroneAirspace(options) {
  return createDroneAirspaceLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    picking,
    ...options,
  });
}
