import { createLiveTvLayer } from '../../layers/liveTv/index.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';

/** Wire the Live TV channel directory layer into the application catalog. */
export function createApplicationLiveTv(options) {
  return createLiveTvLayer({
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    picking,
    pointer: { isPointerFree },
    overlayHost,
    ...options,
  });
}
