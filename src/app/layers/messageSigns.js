import { createMessageSignsLayer } from '../../layers/messageSigns/index.js';
import * as render from '../../renderGovernor.js';
import * as context from '../../data/contextStore.js';
import * as picking from '../../data/pickRegistry.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationMessageSigns({ surface, source }) {
  const { groundFloor } = surface;
  return createMessageSignsLayer({
    source,
    services: { render, context, picking, groundFloor },
  });
}
