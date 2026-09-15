import { createTransitLayer } from '../../layers/transit/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import {
  registerDynamicCredit,
  transitFeedCredit,
} from '../../data/dataCredits.js';

/**
 * Construct one layer using the application scene owners and the
 * application's surface services.
 *
 * The floor comes from `surface.groundFloor` — the ONE instance aircraft,
 * trails, fires and camera geometry stand on — and the rendered-mesh sampler
 * from `surface.meshFloor`, so a mesh floor the application resolves for a
 * cell is the floor transit draws on, and a transit-only session warms its
 * own mesh floors. An earlier cut imported the legacy module-level singleton
 * instead and could not see either.
 *
 * @param {{surface: object}} options
 * @returns {object}
 */
export function createApplicationTransit({ surface, source }) {
  if (!surface?.groundFloor || !surface?.meshFloor)
    throw new TypeError('Transit needs the application surface services');
  const { groundFloor, meshFloor } = surface;
  return createTransitLayer({
    source,
    services: {
      render,
      sprites,
      picking,
      overlays,
      credits: { registerDynamicCredit, transitFeedCredit },
      ground: {
        GROUND_FLOOR_LIFT_M: groundFloor.GROUND_FLOOR_LIFT_M,
        cachedGroundFloor: groundFloor.cachedGroundFloor,
        coarseFloorCoord: groundFloor.coarseFloorCoord,
        neighborFloorM: groundFloor.neighborFloorM,
        warmGroundFloor: groundFloor.warmGroundFloor,
        corridorFloorCells: groundFloor.corridorFloorCells,
        allocateCorridorCells: groundFloor.allocateCorridorCells,
      },
      mesh: { sampleMeshFloorCells: meshFloor.sampleMeshFloorCells },
    },
  });
}
