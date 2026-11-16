import { createEntsoeGridLayer } from '../../layers/entsoeGrid/index.js';
import { entityInteraction } from './entityInteraction.js';
import { overlayHost } from './overlayHost.js';
/** Wire the entsoe-grid layer into the application catalog. */
export function createApplicationEntsoeGrid(options) {
  return createEntsoeGridLayer({
    overlayHost,
    interaction: entityInteraction,
    ...options,
  });
}
