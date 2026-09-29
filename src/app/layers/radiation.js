import { createRadiationLayer } from '../../layers/radiation/index.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';

/** Wire the radiation dose rate layer into the application catalog. */
export function createApplicationRadiation(options) {
  return createRadiationLayer({
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    picking,
    pointer: { isPointerFree },
    overlayHost,
    ...options,
  });
}
