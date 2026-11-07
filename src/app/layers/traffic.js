import { createTrafficLayer } from '../../layers/traffic/index.js';
import * as credits from '../../data/dataCredits.js';
import * as ground from '../../data/groundFloor.js';
import * as render from '../../renderGovernor.js';
import { rendererFor } from './renderers.js';

/**
 * Construct one layer using the application scene owners and a supplied
 * source; it draws with the engine's renderer from the manifest
 * (render/display.js on every engine).
 */
export function createApplicationTraffic({ source, surface }) {
  return createTrafficLayer({
    source,
    services: {
      credits,
      render,
      createRenderer: (engine) => rendererFor('traffic', engine),
      ground: surface?.groundFloor || ground,
    },
  });
}
