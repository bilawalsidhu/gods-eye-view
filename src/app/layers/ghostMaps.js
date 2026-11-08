import { overlayHost } from './overlayHost.js';
import { rendererFor } from './renderers.js';
import { createGhostMapsLayer } from '../../layers/ghostMaps/index.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/**
 * Wire the S2 Underground GhostMaps layer into the application catalog; it
 * draws with the engine's renderer from the manifest (render/display.js on
 * every engine).
 */
export function createApplicationGhostMaps(options) {
  return createGhostMapsLayer({
    overlayHost: overlayHost,
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    picking,
    pointer: { isPointerFree },
    createRenderer: (engine) => rendererFor('s2-ghostmaps', engine),
    ...options,
  });
}
