import { createCzibLayer } from '../../layers/czib/index.js';
import { findAdminArea } from '../../data/adminBoundaries.js';
import * as picking from '../../data/pickRegistry.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { overlayHost } from './overlayHost.js';

/** Resolve an EASA country name to a bundled Natural Earth country. */
async function resolveBundledCountry(name) {
  const area = await findAdminArea(`country of ${name}`);
  return area?.kind === 'country' ? area : null;
}

/** Wire the EASA conflict zone bulletins layer into the application catalog. */
export function createApplicationCzib(options) {
  return createCzibLayer({
    resolveCountry: resolveBundledCountry,
    openExternal: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
    picking,
    pointer: { isPointerFree },
    overlayHost,
    ...options,
  });
}
