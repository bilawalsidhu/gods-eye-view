import { createCctvLayer } from '../../layers/cctv/index.js';
import * as sprites from '../../data/spriteOrder.js';
import * as activation from '../../cctvFocusRequest.js';
import * as overlays from '../../overlays/worldOverlay.js';
import * as locations from '../../locations.js';
import * as picking from '../../data/pickRegistry.js';
import * as focus from '../../data/focusDeemphasis.js';
import * as render from '../../renderGovernor.js';

/** Construct one layer using the application scene owners and a supplied source. */
export function createApplicationCctv({ surface, source }) {
  const { terrain, groundFloor: ground, meshFloor: mesh } = surface;
  return createCctvLayer({
    source,
    services: {
      sprites,
      activation,
      overlays,
      locations,
      picking,
      terrain,
      ground,
      mesh,
      focus,
      render,
    },
  });
}
