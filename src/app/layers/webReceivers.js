import { createWebReceiversLayer } from '../../layers/webReceivers/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationWebReceivers({ surface, source }) {
  const { groundFloor: ground } = surface;
  return createWebReceiversLayer({
    source,
    services: { ground, picking, render },
  });
}
