import { createCyclonesLayer } from '../../layers/cyclones/index.js';
import * as context from '../../data/contextStore.js';

/** Wire cyclone selection to the application shared context. */
export function createApplicationCyclones(options) {
  return createCyclonesLayer({
    context: typeof window !== 'undefined' ? context : null,
    ...options,
  });
}
