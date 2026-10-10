import { createCyclonesLayer } from '../../layers/cyclones/index.js';
import * as context from '../../data/contextStore.js';

/** Wire cyclone selection into the application shared-context owner. */
export function createApplicationCyclones(options) {
  const browserContext = typeof window !== 'undefined' ? { context } : {};
  return createCyclonesLayer({
    ...browserContext,
    ...options,
  });
}
