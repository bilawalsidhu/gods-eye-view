import { rendererFor } from './renderers.js';
import { createSatellitesLayer } from '../../layers/satellites/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as readout from '../../data/trackedReadout.js';
import { worldOverlayFor as overlays } from '../../overlays/worldOverlay.js';
import * as context from '../../data/contextStore.js';
import * as render from '../../renderGovernor.js';
import * as layerState from '../../data/layerState.js';

export function createApplicationSatellites({
  source,
  // Test seam: the renderer factory (default: the engine's, from the
  // manifest: the satellites display on every engine).
  renderer = {
    create: ({ engine = null } = {}) => rendererFor('satellites', engine),
  },
}) {
  return createSatellitesLayer({
    source,
    services: {
      renderer,
      picking,
      focus,
      readout,
      overlays,
      context,
      render,
      layerState,
    },
  });
}
