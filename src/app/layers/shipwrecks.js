import { createShipwrecksLayer } from '../../layers/shipwrecks/index.js';
import * as picking from '../../data/pickRegistry.js';
import { openExternal, overlayHost } from './overlayHost.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire the EMODnet + Wikidata shipwrecks layer into the application catalog. */
export function createApplicationShipwrecks(options) {
  return createShipwrecksLayer({
    overlayHost,
    openExternal,
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
