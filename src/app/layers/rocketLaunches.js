import { rendererFor } from './renderers.js';
import { createRocketLaunchesLayer } from '../../layers/launches/index.js';
import * as geometry from '../../celestialRing.js';
import { worldOverlayFor as overlays } from '../../overlays/worldOverlay.js';
import * as render from '../../renderGovernor.js';

export function createApplicationLaunches({
  source,
  satellites,
  // Test seam: the display factory (default: the engine's, from the
  // manifest: render/display.js on every engine).
  renderer = {
    create: ({ engine }) => rendererFor('rocket-launches', engine),
  },
}) {
  return createRocketLaunchesLayer({
    source,
    services: { satellites, geometry, overlays, render, renderer },
  });
}
