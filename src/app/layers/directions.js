import { createApplicationDirectionsLayer } from '../../data/directions.js';

import { rendererFor } from './renderers.js';

/** Construct Directions with application scene owners and an explicit route source. */
export function createApplicationDirections({ source, surface }) {
  return createApplicationDirectionsLayer({
    source,
    groundFloor: surface?.groundFloor,
    createNativeRenderer: (engine) => rendererFor('directions', engine),
  });
}
