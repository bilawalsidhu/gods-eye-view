import { createSourceSlot } from '../app/sourceSlot.js';
import {
  createSatellitesLayer,
  createSatelliteSource,
} from '../layers/satellites/index.js';
import * as picking from './pickRegistry.js';
import * as focus from './focusDeemphasis.js';
import * as readout from './trackedReadout.js';
import * as overlays from '../overlays/worldOverlay.js';
import * as context from './contextStore.js';
import * as render from '../renderGovernor.js';
import * as layerState from './layerState.js';

const sourceSlot = createSourceSlot(
  createSatelliteSource(),
  ['readGroup'],
  'Satellite source',
);
export const configureSatelliteSource = sourceSlot.configure;
const layer = createSatellitesLayer({
  source: sourceSlot.source,
  services: { picking, focus, readout, overlays, context, render, layerState },
});
export const satelliteVisualsVisible = layer.satelliteVisualsVisible;
export const satelliteCatalogModeChanged = layer.satelliteCatalogModeChanged;
export const createIssOverlayEntry = layer.createIssOverlayEntry;
export const orbitFrameModelMatrix = layer.orbitFrameModelMatrix;
export const _setTrackedSatelliteRefreshStateForTest =
  layer._setTrackedSatelliteRefreshStateForTest;
export const _setSatelliteTrackingRefreshOutcomeForTest =
  layer._setSatelliteTrackingRefreshOutcomeForTest;
export const _trackedFrameCartesianForTest =
  layer._trackedFrameCartesianForTest;
export const _runSatellitePreRenderForTest =
  layer._runSatellitePreRenderForTest;
export const _setDenseCatalogStateForTest = layer._setDenseCatalogStateForTest;
export const _clearDenseCatalogStateForTest =
  layer._clearDenseCatalogStateForTest;
export const _catalogGroupForTest = layer._catalogGroupForTest;
export const _setSatelliteLabelLifecycleStateForTest =
  layer._setSatelliteLabelLifecycleStateForTest;
export const _trackIssForTest = layer._trackIssForTest;
export const _pendingSatelliteTrackingRestoreForTest =
  layer._pendingSatelliteTrackingRestoreForTest;
export const _applyPendingSatelliteTrackingRestoreForTest =
  layer._applyPendingSatelliteTrackingRestoreForTest;
export const _removeSatelliteTrackingCandidateForTest =
  layer._removeSatelliteTrackingCandidateForTest;
export const _clearSatelliteLabelLifecycleForTest =
  layer._clearSatelliteLabelLifecycleForTest;
export const applySatellitePointFocusDeemphasis =
  layer.applySatellitePointFocusDeemphasis;
export const getNextIssPass = layer.getNextIssPass;
export const scoreSatelliteNameMatch = layer.scoreSatelliteNameMatch;
export const findSatelliteOrbitTrackInTle = layer.findSatelliteOrbitTrackInTle;
export const getSatelliteOrbitTrack = layer.getSatelliteOrbitTrack;
export {
  ISS_OVERLAY_SOURCE_ID,
  ISS_OVERLAY_SOURCE_OPTIONS,
} from '../layers/satellites/index.js';
export default layer;
