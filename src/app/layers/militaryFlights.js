import { createMilitaryFlightLayer } from '../../layers/military/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as selection from '../../data/selectionDispatcher.js';
import * as aircraftPresentation from '../../data/tr3bRegistry.js';
import * as trackedCamera from '../../data/trackedCamera.js';
import { rendererFor } from './renderers.js';
import * as labels from '../../data/detectionDraw.js';
import * as geoid from '../../data/geoid.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as readout from '../../data/trackedReadout.js';
import * as context from '../../data/contextStore.js';
import * as render from '../../renderGovernor.js';
import * as recession from '../../data/aircraftRecession.js';

export function createApplicationMilitary({
  surface,
  source,
  militaryRegistry,
  resolveAsset = (url) =>
    `${import.meta.env?.BASE_URL || '/'}${url.replace(/^\//, '')}`,
  // Test seam: the renderer factory (default: the engine's, from the
  // manifest: the military display on every engine).
  renderer = {
    create: ({ engine = null } = {}) => rendererFor('military', engine),
  },
}) {
  const { groundFloor, meshFloor, groundSnap } = surface;
  return createMilitaryFlightLayer({
    source,
    resolveAsset,
    services: {
      picking,
      selection,
      // The engine's military renderer from the manifest (render/display.js).
      renderer,
      aircraftPresentation,
      camera: trackedCamera,
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
