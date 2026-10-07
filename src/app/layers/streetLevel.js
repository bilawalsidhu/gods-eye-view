import { createStreetLevelLayer } from '../../layers/streetLevel/index.js';
import { createMapillaryProvider } from '../../layers/streetLevel/providers/mapillary/index.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as input from '../../data/inputOwnership.js';
import * as render from '../../renderGovernor.js';

/** A new provider registers here; its chip, credit and share bit follow. */
export function createApplicationStreetLevel({ sources }) {
  return createStreetLevelLayer({
    providers: [createMapillaryProvider({ source: sources.mapillary })],
    services: { sprites, picking, input, render },
  });
}
