import { createBikeshareLayer } from '../../layers/bikeshare/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationBikeshare({ source, surface }) {
  return createBikeshareLayer({
    source,
    services: {
      render,
      sprites,
      picking,
      overlays,
      // Station heights come from the terrain surface every layer shares.
      ground: { terrainSurface: surface?.groundFloor?.terrainSurface },
    },
  });
}
