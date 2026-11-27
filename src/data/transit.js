import { createTransitLayer } from '../layers/transit/index.js';
import * as render from '../renderGovernor.js';
import * as sprites from './spriteOrder.js';
import * as picking from './pickRegistry.js';
import * as overlays from '../overlays/worldOverlay.js';
import { registerDynamicCredit, transitFeedCredit } from './dataCredits.js';
import {
  GROUND_FLOOR_LIFT_M,
  cachedGroundFloor,
  coarseFloorCoord,
  neighborFloorM,
  warmGroundFloor,
} from './groundFloor.js';
import { sampleMeshFloorCells } from './meshFloorSampler.js';

const layer = createTransitLayer({
  services: {
    render,
    sprites,
    picking,
    overlays,
    credits: { registerDynamicCredit, transitFeedCredit },
    ground: {
      GROUND_FLOOR_LIFT_M,
      cachedGroundFloor,
      coarseFloorCoord,
      neighborFloorM,
      warmGroundFloor,
    },
    // The module-scoped sampler shares the module-scoped floor (./groundFloor.js,
    // ./meshFloorSampler.js), so standalone transit warms its own mesh floors.
    mesh: { sampleMeshFloorCells },
  },
});

export const _setTransitOverlayHostForTest =
  layer._setTransitOverlayHostForTest;
export const _transitStateForTest = layer._transitStateForTest;
export { createTransitLayer } from '../layers/transit/index.js';
export {
  TRANSIT_MODE_COLORS,
  TRANSIT_POLL_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  aggregateTransitFeedHealth,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
  isStaleVehicleFix,
  transitDetectionClass,
  transitDetectionId,
  transitDetectionMetric,
  transitVehicleKey,
  vehicleFixAgeMs,
} from '../layers/transit/policy.js';
export default layer;
