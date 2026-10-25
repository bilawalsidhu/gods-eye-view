import * as credits from '../../data/dataCredits.js';
import { createEvChargingLayer } from '../../layers/evCharging/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

/** Construct the EV charging layer with the application scene owners. */
export function createApplicationEvCharging({ surface, source }) {
  return createEvChargingLayer({
    source,
    services: {
      credits,
      render,
      context,
      picking,
      groundFloor: surface.groundFloor,
    },
  });
}
