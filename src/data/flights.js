import { defaultSurface } from './surfaceServices.js';
import { createApplicationFlights } from '../app/layers/flights.js';

import { createOpenSkySource } from '../sources/live/standalone.js';
import * as militaryRegistry from './militaryRegistry.js';

const flightsLayer = createApplicationFlights({
  surface: defaultSurface,
  source: createOpenSkySource(),
  militaryRegistry,
});
export { TRACKED_MODEL_MAX_PX } from '../layers/flights/policy.js';
export const _floorGroundedDisplayPositionForTest =
  flightsLayer.testing._floorGroundedDisplayPositionForTest;
export const _clearDisplayFloorStateForTest =
  flightsLayer.testing._clearDisplayFloorStateForTest;
export const _setTrackedFlightRefreshStateForTest =
  flightsLayer.testing._setTrackedFlightRefreshStateForTest;
export const _setFlightTrackingRefreshOutcomeForTest =
  flightsLayer.testing._setFlightTrackingRefreshOutcomeForTest;
export const _addFlightTrackingCandidateForTest =
  flightsLayer.testing._addFlightTrackingCandidateForTest;
export const _militaryLayerSuppressesForTest =
  flightsLayer.testing._militaryLayerSuppressesForTest;
export const _armFlightTrackingRestoreForTest =
  flightsLayer.testing._armFlightTrackingRestoreForTest;
export const _pendingFlightTrackingRestoreForTest =
  flightsLayer.testing._pendingFlightTrackingRestoreForTest;
export const _applyPendingFlightTrackingRestoreForTest =
  flightsLayer.testing._applyPendingFlightTrackingRestoreForTest;
export const _setCockpitDetectionSubjectForTest =
  flightsLayer.testing._setCockpitDetectionSubjectForTest;
export const _trackedModelRegimeActiveForTest =
  flightsLayer.testing._trackedModelRegimeActiveForTest;
export const _updateTrackedModelForTest =
  flightsLayer.testing._updateTrackedModelForTest;
export const _trackedBillboardColorForTest =
  flightsLayer.testing._trackedBillboardColorForTest;
export const _driveFleetModelHandoffForTest =
  flightsLayer.testing._driveFleetModelHandoffForTest;
export const _ensureFleetModelForTest =
  flightsLayer.testing._ensureFleetModelForTest;
export const mapAnalystRecord = flightsLayer.mapAnalystRecord;
export default flightsLayer;
