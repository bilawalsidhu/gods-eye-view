import { createShipwrecksLayer } from '../../layers/shipwrecks/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire the EMODnet + Wikidata shipwrecks layer into the application catalog. */
export function createApplicationShipwrecks(options) {
  return createShipwrecksLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
