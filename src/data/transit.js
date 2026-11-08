import { createTransitLayer as createLayer } from '../layers/transit/index.js';
import { createTransitDisplay } from '../layers/transit/render/display.js';
import * as render from '../renderGovernor.js';
import * as picking from './pickRegistry.js';
import { worldOverlayFor as overlays } from '../overlays/worldOverlay.js';
import { registerDynamicCredit, transitFeedCredit } from './dataCredits.js';
import {
  GROUND_FLOOR_LIFT_M,
  cachedGroundFloor,
  coarseFloorCoord,
  neighborFloorM,
  warmGroundFloor,
} from './groundFloor.js';
import { sampleMeshFloorCells } from './meshFloorSampler.js';

export function createTransitLayer(options) {
  return createLayer({
    rendererFactory: ({ engine, ...context }) =>
      createTransitDisplay(engine, context),
    ...options,
  });
}

const layer = createTransitLayer({
  services: {
    render,
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
    // The legacy sampler over the same legacy floor, so this standalone
    // module warms its own mesh floors the way the application layer does.
    mesh: { sampleMeshFloorCells },
  },
});

export const _setTransitOverlayHostForTest =
  layer._setTransitOverlayHostForTest;
export const _transitStateForTest = layer._transitStateForTest;
export {
  TRANSIT_MODE_COLORS,
  TRANSIT_POLL_MS,
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  aggregateTransitFeedHealth,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
  interpolatedVehiclePosition,
  isStaleVehicleFix,
  transitDetectionClass,
  transitDetectionId,
  transitDetectionMetric,
  transitVehicleKey,
  vehicleFixAgeMs,
} from '../layers/transit/index.js';
export default layer;
