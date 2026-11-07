import { worldOverlayFor } from '../../overlays/worldOverlay.js';
import { rendererFor } from './renderers.js';
import { createGhostMapsLayer } from '../../layers/ghostMaps/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/**
 * Wire the S2 Underground GhostMaps layer into the application catalog; it
 * draws with the engine's renderer from the manifest (render/display.js on
 * every engine).
 */
export function createApplicationGhostMaps(options) {
  return createGhostMapsLayer({
    overlayHost: {
      forEngine: worldOverlayFor,
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    picking,
    pointer: { isPointerFree },
    createRenderer: (engine) => rendererFor('s2-ghostmaps', engine),
    ...options,
  });
}
