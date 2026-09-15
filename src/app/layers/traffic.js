import { createTrafficLayer } from '../../layers/traffic/index.js';
import * as credits from '../../data/dataCredits.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationTraffic({ source }) {
  return createTrafficLayer({
    source,
    services: { credits, render },
  });
}
