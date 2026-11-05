import { rendererFor } from './renderers.js';
import { createSatellitesCesiumRenderer } from '../../layers/satellites/render/cesium.js';
import { createSatellitesLayer } from '../../layers/satellites/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as readout from '../../data/trackedReadout.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as context from '../../data/contextStore.js';
import * as render from '../../renderGovernor.js';
import * as layerState from '../../data/layerState.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationSatellites({
  source,
  renderer = {
    create: ({ engine = null, ...options }) =>
      engine
        ? rendererFor('satellites', engine, options)
        : createSatellitesCesiumRenderer(null, options),
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
