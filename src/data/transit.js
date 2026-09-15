/**
 * @module transit
 * @description Application handle for the Transit layer.
 *
 * The layer lives in `src/layers/transit/` and imports nothing but Cesium and
 * the feed registry. This module binds its source slot for the standalone
 * app and re-exports the layer's pure helpers for the tests.
 */

import { createApplicationTransit } from '../app/layers/transit.js';
import { createSourceSlot } from '../app/sourceSlot.js';
import { createTransitSource } from '../layers/transit/source.js';

const sourceSlot = createSourceSlot(
  createTransitSource(),
  ['getVehicles'],
  'Transit source',
);
export const configureTransitSource = sourceSlot.configure;
const layer = createApplicationTransit({ source: sourceSlot.source });

export { createApplicationTransit };
export {
  TRANSIT_SELECTED_OVERLAY_SOURCE_ID,
  TRANSIT_SELECTED_OVERLAY_SOURCE_OPTIONS,
  TRANSIT_POLL_MS,
  TRANSIT_MODE_COLORS,
  ACTIVATION_ALTITUDE_M,
  FLOOR_ANCHOR_MAX_ALTITUDE_M,
  MISSED_POLLS_TO_DROP,
  VEHICLE_MAX_AGE_S,
  createTransitLayer,
  createTransitSource,
  transitVehicleKey,
  interpolatedVehiclePosition,
  isStaleVehicleFix,
  vehicleHeightM,
  vehicleVisible,
  buildTransitSelectionCopy,
  createTransitSelectedOverlayEntry,
  transitStats,
} from '../layers/transit/index.js';
export default layer;
