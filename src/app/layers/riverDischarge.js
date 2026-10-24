import * as credits from '../../data/dataCredits.js';
import { createRiverDischargeLayer } from '../../layers/riverDischarge/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

/** Construct the river discharge outlook layer with the application scene owners. */
export function createApplicationRiverDischarge({ source }) {
  return createRiverDischargeLayer({
    source,
    services: { credits, render, context, picking },
  });
}
