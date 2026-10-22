import { rendererFor } from './renderers.js';
import { createLaunchesCesiumRenderer } from '../../layers/launches/render/cesium.js';
import { createRocketLaunchesLayer } from '../../layers/launches/index.js';
import * as geometry from '../../celestialRing.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationLaunches({
  source,
  satellites,
  renderer = {
    create: ({ engine = null, ...options }) =>
      engine
        ? rendererFor('rocket-launches', engine, options)
        : createLaunchesCesiumRenderer(null, options),
  },
}) {
  return createRocketLaunchesLayer({
    source,
    services: { satellites, geometry, overlays, render, renderer },
  });
}
