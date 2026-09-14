import { createSourceSlot } from '../app/sourceSlot.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createCctvLayer } from '../layers/cctv/index.js';
import * as sprites from './spriteOrder.js';
import * as activation from '../cctvFocusRequest.js';
import * as overlays from '../overlays/worldOverlay.js';
import * as locations from '../locations.js';
import * as picking from './pickRegistry.js';
import * as terrain from './terrainHeights.js';
import * as ground from './groundFloor.js';
import * as mesh from './meshFloorSampler.js';
import * as focus from './focusDeemphasis.js';
import * as render from '../renderGovernor.js';

const sourceSlot = createSourceSlot(
  createCctvSource(),
  ['getCatalog', 'getHealth', 'getFrameUrl', 'getMediaUrl'],
  'Cctv source',
);
export const configureCctvSource = sourceSlot.configure;
const layer = createCctvLayer({
  source: sourceSlot.source,
  services: {
    sprites,
    activation,
    overlays,
    locations,
    picking,
    terrain,
    ground,
    mesh,
    focus,
    render,
  },
});
export const calibrationPatchMovesAnchor = layer.calibrationPatchMovesAnchor;
export const migrateRangeScaleForFloor = layer.migrateRangeScaleForFloor;
export const _pushAmbientCardEntriesForTest =
  layer._pushAmbientCardEntriesForTest;
export const _setCctvOverlayHostForTest = layer._setCctvOverlayHostForTest;
export const createCctvProjectionOverlayEntry =
  layer.createCctvProjectionOverlayEntry;
export const setCctvCardPresentationOptions =
  layer.setCctvCardPresentationOptions;
export const surfaceRegimeKey = layer.surfaceRegimeKey;
export const normalizeCoverageMode = layer.normalizeCoverageMode;
export const readCalibrationStoreV2 = layer.readCalibrationStoreV2;
export const writeCalibrationStoreV2 = layer.writeCalibrationStoreV2;
export const deriveCalBadge = layer.deriveCalBadge;
export const computeFrustumGeometry = layer.computeFrustumGeometry;
export const activationProbeClampRange = layer.activationProbeClampRange;
export const frameSignatureFromPixels = layer.frameSignatureFromPixels;
export const _createCctvProjectionPlaneForTest =
  layer._createCctvProjectionPlaneForTest;
export const _updateCctvProjectionPlaneForTest =
  layer._updateCctvProjectionPlaneForTest;
export const applyCctvFocusDeemphasis = layer.applyCctvFocusDeemphasis;
export const createGeometryProgressNotifier =
  layer.createGeometryProgressNotifier;
export const processCctvGeometryQueueBatch =
  layer.processCctvGeometryQueueBatch;
export const cctvGeometryDrainPacing = layer.cctvGeometryDrainPacing;
export const processCctvGeometryDrainBatch =
  layer.processCctvGeometryDrainBatch;
export const prioritizeActiveCctvGeometryRecord =
  layer.prioritizeActiveCctvGeometryRecord;
export const processGeometryBatch = layer.processGeometryBatch;
export const hideCctvRecordVisuals = layer.hideCctvRecordVisuals;
export const refreshCoverageStyles = layer.refreshCoverageStyles;
export const clearProbeClampOnDeactivation =
  layer.clearProbeClampOnDeactivation;
export const cctvRecordNeedsActivation = layer.cctvRecordNeedsActivation;
export const bindCctvWorldClickGesture = layer.bindCctvWorldClickGesture;
export const setActiveCamera = layer.setActiveCamera;
export const deactivateActiveCamera = layer.deactivateActiveCamera;
export const cctvEmptyClickDeselects = layer.cctvEmptyClickDeselects;
export const materializeCctvCoverageEntities =
  layer.materializeCctvCoverageEntities;
export const materializeCctvActiveCoverageEntities =
  layer.materializeCctvActiveCoverageEntities;
export const materializeCctvVisibleCoverageEntities =
  layer.materializeCctvVisibleCoverageEntities;
export const _extractPickedCameraIdForTest =
  layer._extractPickedCameraIdForTest;
export const _setCctvCoverageStateForTest = layer._setCctvCoverageStateForTest;
export const focusCctvRecord = layer.focusCctvRecord;
export const maybeAutoHop = layer.maybeAutoHop;
export const cctvCycleIndex = layer.cctvCycleIndex;
export {
  CCTV_CALIBRATION_STORAGE_KEY_V1,
  CCTV_CALIBRATION_STORAGE_KEY_V2,
  FRUSTUM_GROUND_CLEARANCE_M,
  CCTV_FOCUS_RESULT,
  CCTV_PROJECTION_OVERLAY_SOURCE_ID,
  CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
} from '../layers/cctv/index.js';
export default layer;
