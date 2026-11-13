import { createRailLayer } from '../../layers/rail/index.js';
import * as render from '../../renderGovernor.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import { applyTrackedCameraFrame } from '../../data/trackedCamera.js';
import { WORLD_FOCUS_FRAMING, requestWorldFocus } from '../../worldFocus.js';
import {
  railFeedCredit,
  registerDynamicCredit,
} from '../../data/dataCredits.js';

/**
 * Construct the Rail layer on the application's scene owners and its shared
 * ground floor, the same floor Transit and the aircraft stand on.
 * @param {{surface: object, source?: object}} options
 * @returns {object}
 */
export function createApplicationRail({ surface, source }) {
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
      credits: { registerDynamicCredit, railFeedCredit },
      ground: {
        GROUND_FLOOR_LIFT_M: groundFloor.GROUND_FLOOR_LIFT_M,
        cachedGroundFloor: groundFloor.cachedGroundFloor,
        warmGroundFloor: groundFloor.warmGroundFloor,
        neighborFloorM: groundFloor.neighborFloorM,
        coarseFloorCoord: groundFloor.coarseFloorCoord,
      },
      // A selected train is followed as a tracked aircraft is, or flown to
      // once as a vessel is (src/layers/rail/follow.js).
      camera: {
        framing: WORLD_FOCUS_FRAMING.train,
        requestWorldFocus,
        applyTrackedCameraFrame,
        isCockpitActive: () =>
          globalThis.document?.body?.classList?.contains('cockpit-mode') ===
          true,
      },
    },
  });
}
