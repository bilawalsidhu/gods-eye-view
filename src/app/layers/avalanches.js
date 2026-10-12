import { createAvalancheLayer } from '../../layers/avalanches/index.js';
import * as render from '../../renderGovernor.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import * as overlays from '../../overlays/worldOverlay.js';

/** Wire the avalanche layer to the application render, pick and overlay hosts. */
export function createApplicationAvalanches({ source }) {
  return createAvalancheLayer({
    source,
    services: {
      render,
      picking,
      pointer: { isPointerFree },
      overlay: {
        setEntries: overlays.setOverlayEntries,
        setVisible: overlays.setOverlaySourceVisible,
        clearSource: overlays.clearOverlaySource,
        hitTest: overlays.hitTestWorldOverlay,
      },
      openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    },
  });
}
