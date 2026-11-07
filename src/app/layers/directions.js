import { createApplicationDirectionsLayer } from '../../data/directions.js';

import { rendererFor } from './renderers.js';

/**
 * Construct Directions with application scene owners and an explicit route
 * source; it draws with the engine's renderer from the registry
 * (render/display.js on every engine).
 */
export function createApplicationDirections({ source, surface }) {
  return createApplicationDirectionsLayer({
    source,
    groundFloor: surface?.groundFloor,
    createRenderer: (engine) => rendererFor('directions', engine),
  });
}
