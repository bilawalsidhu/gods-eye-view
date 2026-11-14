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
import * as readouts from '../../hudReadouts.js';
import { fleetModelServices } from './fleetModels.js';

/**
 * Construct one layer using the application scene owners and a supplied
 * source. `displayParams` reads the Flights layer's DISPLAY-rail 3D
 * preference, under which nearby vessels are drawn as fleet models.
 */
export function createApplicationVessels({
  source,
  options = {},
  displayParams = null,
  resolveAsset,
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
      readouts,
      fleet: fleetModelServices({
        display: displayParams,
        ...(resolveAsset ? { resolveAsset } : {}),
      }),
    },
  });
}
