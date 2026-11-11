import { createTrafficLayer } from '../../layers/traffic/index.js';
import * as credits from '../../data/dataCredits.js';
import * as ground from '../../data/groundFloor.js';
import * as render from '../../renderGovernor.js';
import { rendererFor } from './renderers.js';

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
