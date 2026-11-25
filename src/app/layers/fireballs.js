import { createFireballsLayer } from '../../layers/fireballs/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire the NASA/JPL CNEOS fireballs layer into the application catalog. */
export function createApplicationFireballs(options) {
  return createFireballsLayer({
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
