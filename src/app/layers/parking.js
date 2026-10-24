import * as credits from '../../data/dataCredits.js';
import { createParkingLayer } from '../../layers/parking/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';
import { refreshTrackedReadout } from '../../data/trackedReadout.js';

/** Construct the parking layer with the application scene owners. */
export function createApplicationParking({ surface, source }) {
  return createParkingLayer({
    source,
    services: {
      credits,
      render,
      context,
      picking,
      readout: { refreshTrackedReadout },
      groundFloor: surface.groundFloor,
    },
  });
}
