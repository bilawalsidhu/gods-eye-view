import { createRailLayer } from '../../layers/rail/index.js';
import * as render from '../../renderGovernor.js';
import { fleetModelServices } from './fleetModels.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { requestWorldFocus } from '../../worldFocus.js';
import {
  railFeedCredit,
  registerDynamicCredit,
} from '../../data/dataCredits.js';

/**
 * Construct the Rail layer on the application's scene owners and its shared
 * ground floor, the same floor Transit and the aircraft stand on.
 * `displayParams` reads the Flights layer's DISPLAY-rail 3D preference, under
 * which nearby trains are drawn as fleet models.
 * `placement` is a host-supplied placement for its live trains, or null.
 * @param {{surface: object, source?: object, placement?: object|null,
 *   displayParams?: () => object|null, resolveAsset?: (url: string) => string}} options
 * @returns {object}
 */
export function createApplicationRail({
  surface,
  source,
  placement = null,
  displayParams = null,
  resolveAsset,
}) {
  if (!surface?.groundFloor)
    throw new TypeError('Rail needs the application surface services');
  const { groundFloor } = surface;
  return createRailLayer({
    source,
    services: {
      render,
      sprites,
      picking,
      overlays,
      placement,
      credits: { registerDynamicCredit, railFeedCredit },
      ground: {
        GROUND_FLOOR_LIFT_M: groundFloor.GROUND_FLOOR_LIFT_M,
        cachedGroundFloor: groundFloor.cachedGroundFloor,
        warmGroundFloor: groundFloor.warmGroundFloor,
        neighborFloorM: groundFloor.neighborFloorM,
        coarseFloorCoord: groundFloor.coarseFloorCoord,
      },
      // A clicked train is centred once, keeping the view, as a vessel is;
      // the camera does not follow it (src/layers/rail/focus.js).
      camera: { requestWorldFocus },
      fleet: fleetModelServices({
        display: displayParams,
        ...(resolveAsset ? { resolveAsset } : {}),
      }),
    },
  });
}
