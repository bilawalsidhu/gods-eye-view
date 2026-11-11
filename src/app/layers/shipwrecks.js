import { createShipwrecksLayer } from '../../layers/shipwrecks/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire the shipwreck markers and cards to the current scene. */
export function createApplicationShipwrecks(options) {
  return createShipwrecksLayer({
    overlayHost,
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    ...options,
  });
}
