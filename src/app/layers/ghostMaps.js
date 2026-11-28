import { createGhostMapsLayer } from '../../layers/ghostMaps/index.js';
import * as picking from '../../data/pickRegistry.js';
import { openExternal, overlayHost } from './overlayHost.js';

/** Wire the S2 Underground GhostMaps layer into the application catalog. */
export function createApplicationGhostMaps(options) {
  return createGhostMapsLayer({
    overlayHost,
    openExternal,
    picking,
    ...options,
  });
}
