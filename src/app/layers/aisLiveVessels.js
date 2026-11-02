import { createVesselLayer } from '../../layers/vessels/index.js';
import * as context from '../../data/contextStore.js';
import * as trails from '../../data/trailRenderer.js';
import * as labels from '../../data/detectionDraw.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlay from '../../overlays/worldOverlay.js';
import * as geoid from '../../data/geoid.js';
import * as sprites from '../../data/spriteOrder.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as worldFocus from '../../worldFocus.js';
import * as render from '../../renderGovernor.js';
import * as selection from '../../data/selectionDispatcher.js';
import { rendererFor } from './renderers.js';
import { createVesselsCesiumRenderer } from '../../layers/vessels/render/cesium.js';
import * as readouts from '../../hudReadouts.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationVessels({
  source,
  options = {},
  // Test seam: the renderer factory (default: the engine's, from the registry).
  renderer = {
    create: ({ engine = null, ...rendererOptions }) =>
      engine
        ? rendererFor('ais-live-vessels', engine, rendererOptions)
        : createVesselsCesiumRenderer(null, rendererOptions),
  },
}) {
  return createVesselLayer({
    source,
    options,
    services: {
      context,
      trails,
      labels,
      picking,
      overlay,
      geoid,
      sprites,
      focus,
      worldFocus,
      render,
      selection,
      // The engine's vessel renderer from the registry (render/cesium.js on
      // Cesium); a bare viewer without an engine (unit tests) draws on Cesium.
      renderer,
      readouts,
    },
  });
}
