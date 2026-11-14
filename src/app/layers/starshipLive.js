import { createStarshipLiveLayer } from '../../layers/starshipLive/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as context from '../../data/contextStore.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationStarshipLive({ source }) {
  return createStarshipLiveLayer({
    source,
    services: {
      picking,
      context,
      render,
    },
  });
}
