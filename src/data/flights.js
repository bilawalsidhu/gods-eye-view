import { createCivilFlightLayer } from '../layers/flights/index.js';
import { createOpenSkySource } from '../sources/live/standalone.js';
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

const flightsLayer = createCivilFlightLayer({
  source: createOpenSkySource(),
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
