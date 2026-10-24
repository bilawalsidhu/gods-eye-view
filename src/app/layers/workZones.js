import { createWorkZonesLayer } from '../../layers/workZones/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

/** Construct the US work zones layer with the application scene owners. */
export function createApplicationWorkZones({ surface, source }) {
  return createWorkZonesLayer({
    source,
    services: {
      render,
      context,
      picking,
      groundFloor: surface.groundFloor,
    },
  });
}
