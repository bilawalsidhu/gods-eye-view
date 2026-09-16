import { createCivilFlightLayer } from '../../layers/flights/index.js';
import { registerDynamicCredit } from '../../data/dataCredits.js';
import * as picking from '../../data/pickRegistry.js';
import * as sprites from '../../data/spriteOrder.js';
import * as trails from '../../data/trailRenderer.js';
import * as aircraftPresentation from '../../data/tr3bRegistry.js';
import * as camera from '../../data/trackedCamera.js';
import * as labels from '../../data/detectionDraw.js';
import * as geoid from '../../data/geoid.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as readout from '../../data/trackedReadout.js';
import * as context from '../../data/contextStore.js';
import * as render from '../../renderGovernor.js';
import * as recession from '../../data/aircraftRecession.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationFlights({
  surface,
  source,
  militaryRegistry,
  resolveAsset = (url) =>
    `${import.meta.env?.BASE_URL || '/'}${url.replace(/^\//, '')}`,
}) {
  const { groundFloor, meshFloor, groundSnap } = surface;
  return createCivilFlightLayer({
    source,
    resolveAsset,
    services: {
      credits: { registerDynamicCredit },
      picking,
      sprites,
      trails,
      aircraftPresentation,
      camera,
      militaryRegistry,
      labels,
      groundFloor,
      meshFloor,
      geoid,
      focus,
      readout,
      context,
      render,
      groundSnap,
      recession,
    },
  });
}
