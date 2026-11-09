import { createVesselLayer } from '../../layers/vessels/index.js';
import * as context from '../../data/contextStore.js';
import * as labels from '../../data/detectionDraw.js';
import * as picking from '../../data/pickRegistry.js';
import { worldOverlayFor as overlay } from '../../overlays/worldOverlay.js';
import * as geoid from '../../data/geoid.js';
import * as sprites from '../../data/spriteOrder.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as worldFocus from '../../worldFocus.js';
import * as render from '../../renderGovernor.js';
import * as selection from '../../data/selectionDispatcher.js';
import { rendererFor } from './renderers.js';
import * as readouts from '../../hudReadouts.js';

export function createApplicationVessels({
  source,
  options = {},
  // Test seam: the renderer factory (default: the engine's, from the
  // manifest: the vessels display on every engine; none without an engine).
  renderer = {
    create: ({ engine = null } = {}) => rendererFor('ais-live-vessels', engine),
  },
}) {
  return createVesselLayer({
    source,
    options,
    services: {
      context,
      labels,
      picking,
      overlay,
      geoid,
      sprites,
      focus,
      worldFocus,
      render,
      selection,
      // The engine's vessel display from the manifest (render/display.js).
      renderer,
      readouts,
    },
  });
}
