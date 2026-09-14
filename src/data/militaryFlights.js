import { createMilitaryFlightLayer } from '../layers/military/index.js';
import { createAdsbLolSource } from '../sources/live/standalone.js';
import * as picking from './pickRegistry.js';
import * as sprites from './spriteOrder.js';
import * as trails from './trailRenderer.js';
import * as aircraftPresentation from './tr3bRegistry.js';
import * as camera from './trackedCamera.js';
import * as militaryRegistry from './militaryRegistry.js';
import * as labels from './detectionDraw.js';
import * as groundFloor from './groundFloor.js';
import * as meshFloor from './meshFloorSampler.js';
import * as geoid from './geoid.js';
import * as focus from './focusDeemphasis.js';
import * as readout from './trackedReadout.js';
import * as context from './contextStore.js';
import * as render from '../renderGovernor.js';
import * as groundSnap from './groundSnap.js';
import * as recession from './aircraftRecession.js';

const militaryFlightsLayer = createMilitaryFlightLayer({
  source: createAdsbLolSource(),
  resolveAsset: (url) =>
    `${import.meta.env?.BASE_URL || '/'}${url.replace(/^\//, '')}`,
  services: {
    picking,
    sprites,
    trails,
    aircraftPresentation,
    camera,
    militaryRegistry,
    labels,
    groundFloor,
    meshFloor,
    geoid,
    focus,
    readout,
    context,
    render,
    groundSnap,
    recession,
  },
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
