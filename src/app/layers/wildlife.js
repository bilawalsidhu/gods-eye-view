import { createWildlifeLayer } from '../../layers/wildlife/index.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';

/** Wire the Movebank wildlife tracks layer into the application catalog. */
export function createApplicationWildlife(options) {
  return createWildlifeLayer({
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    picking,
    pointer: { isPointerFree },
    ...options,
  });
}
