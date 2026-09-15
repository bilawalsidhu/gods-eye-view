import { defaultSurface } from './surfaceServices.js';
import { createApplicationMilitary } from '../app/layers/militaryFlights.js';

import { createAdsbLolSource } from '../sources/live/standalone.js';
import * as militaryRegistry from './militaryRegistry.js';

const militaryFlightsLayer = createApplicationMilitary({
  surface: defaultSurface,
  source: createAdsbLolSource(),
  militaryRegistry,
});
export { TRACKED_MODEL_MAX_PX } from '../layers/military/policy.js';
export const _setTrackedMilitaryRefreshStateForTest =
  militaryFlightsLayer.testing._setTrackedMilitaryRefreshStateForTest;
export const _setMilitaryTrackingRefreshOutcomeForTest =
  militaryFlightsLayer.testing._setMilitaryTrackingRefreshOutcomeForTest;
export const _addMilitaryTrackingCandidateForTest =
  militaryFlightsLayer.testing._addMilitaryTrackingCandidateForTest;
export const _pendingMilitaryTrackingRestoreForTest =
  militaryFlightsLayer.testing._pendingMilitaryTrackingRestoreForTest;
export const _applyPendingMilitaryTrackingRestoreForTest =
  militaryFlightsLayer.testing._applyPendingMilitaryTrackingRestoreForTest;
export const _setCockpitDetectionSubjectForTest =
  militaryFlightsLayer.testing._setCockpitDetectionSubjectForTest;
export const _trackedModelRegimeActiveForTest =
  militaryFlightsLayer.testing._trackedModelRegimeActiveForTest;
export const _updateTrackedModelForTest =
  militaryFlightsLayer.testing._updateTrackedModelForTest;
export const _trackedBillboardColorForTest =
  militaryFlightsLayer.testing._trackedBillboardColorForTest;
export const _driveFleetModelHandoffForTest =
  militaryFlightsLayer.testing._driveFleetModelHandoffForTest;
export const _ensureFleetModelForTest =
  militaryFlightsLayer.testing._ensureFleetModelForTest;
export const mapAnalystRecord = militaryFlightsLayer.mapAnalystRecord;
export default militaryFlightsLayer;
