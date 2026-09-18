import { createSatellitesLayer } from '../../layers/satellites/index.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as readout from '../../data/trackedReadout.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as context from '../../data/contextStore.js';
import * as render from '../../renderGovernor.js';
import * as layerState from '../../data/layerState.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationSatellites({ source }) {
  return createSatellitesLayer({
    source,
    services: {
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
