import { createHamRepeatersLayer } from '../../layers/hamRepeaters/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as context from '../../data/contextStore.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationHamRepeaters({ surface, source }) {
  const { groundFloor: ground } = surface;
  return createHamRepeatersLayer({
    source,
    services: { ground, picking, context, render },
  });
}
