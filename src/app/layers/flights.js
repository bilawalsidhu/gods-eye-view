import { createCivilFlightLayer } from '../../layers/flights/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as selection from '../../data/selectionDispatcher.js';
import * as aircraftPresentation from '../../data/tr3bRegistry.js';
import * as trackedCamera from '../../data/trackedCamera.js';
import { rendererFor } from './renderers.js';
import { createFlightsCesiumRenderer } from '../../layers/flights/render/cesium.js';
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
  // Test seam: the renderer factory (default: the engine's, from the registry).
  renderer = {
    create: ({ viewer, engine = null, adopt }) =>
      engine
        ? rendererFor('flights', engine, { viewer, adopt })
        : createFlightsCesiumRenderer(null, { viewer, adopt }),
  },
}) {
  const { groundFloor, meshFloor, groundSnap } = surface;
  return createCivilFlightLayer({
    source,
    resolveAsset,
    services: {
      picking,
      selection,
      // The engine's flights renderer from the registry (render/cesium.js on
      // Cesium); a bare viewer without an engine (unit tests) draws on Cesium.
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
