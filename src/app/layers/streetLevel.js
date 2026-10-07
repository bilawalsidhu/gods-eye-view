import { createStreetLevelLayer } from '../../layers/streetLevel/index.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as render from '../../renderGovernor.js';

/** The Street Level layer over the application's Mapillary source. */
export function createApplicationStreetLevel({ sources }) {
  return createStreetLevelLayer({
    source: sources.mapillary,
    services: { sprites, picking, input, render },
  });
}
