import {
  createFirePerimetersLayer,
  createInciwebIndexSource,
  createInciwebPublicationSource,
} from '../../layers/perimeters/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';

/** Wire WFIGS fire perimeters into the application catalog. */
export function createApplicationFirePerimeters(options) {
  return createFirePerimetersLayer({
    overlayHost: {
      setEntries: overlays.setOverlayEntries,
      setVisible: overlays.setOverlaySourceVisible,
      clearSource: overlays.clearOverlaySource,
      hitTest: overlays.hitTestWorldOverlay,
    },
    inciwebSource: createInciwebIndexSource(),
    inciwebPublications: createInciwebPublicationSource(),
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    picking,
    ...options,
  });
}
