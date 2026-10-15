import { createCalibration } from './calibration.js';
import { createTesting } from './testing.js';
import { createProjection } from './projection.js';
import { createCards } from './cards.js';
import { createModel } from './model.js';
import { createGround } from './ground.js';
import { createGeometry } from './geometry.js';
import { createCatalog } from './catalog.js';
import { createFrames } from './frames.js';
import { createRendering } from './rendering.js';
import { createGeometryQueue } from './geometryQueue.js';
import { createSelection } from './selection.js';
import { createHover } from './hover.js';
import { createNavigation } from './navigation.js';
import { createPresentation } from './presentation.js';
import { createLifecycle } from './lifecycle.js';
import { createHealth } from './health.js';
import { createControls } from './controls.js';
import { createIngestion } from './ingestion.js';
import { createState } from './state.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createCctvLayer({ services, source }) {
  if (
    !['getCatalog', 'getHealth', 'getFrameUrl', 'getMediaUrl'].every(
      (key) => typeof source?.[key] === 'function',
    )
  )
    throw new TypeError('A camera source is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source };
  parts.calibration = createCalibration(context);
  parts.testing = createTesting(context);
  parts.projection = createProjection(context);
  parts.cards = createCards(context);
  parts.model = createModel(context);
  parts.ground = createGround(context);
  parts.geometry = createGeometry(context);
  parts.catalog = createCatalog(context);
  parts.frames = createFrames(context);
  parts.rendering = createRendering(context);
  parts.geometryQueue = createGeometryQueue(context);
  parts.selection = createSelection(context);
  parts.hover = createHover(context);
  parts.navigation = createNavigation(context);
  parts.presentation = createPresentation(context);
  parts.lifecycle = createLifecycle(context);
  parts.health = createHealth(context);
  parts.controls = createControls(context);
  parts.ingestion = createIngestion(context);
  return Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion?.methods,
    {
      calibrationPatchMovesAnchor:
        parts.calibration.calibrationPatchMovesAnchor,
      migrateRangeScaleForFloor: parts.calibration.migrateRangeScaleForFloor,
      _pushAmbientCardEntriesForTest:
        parts.testing._pushAmbientCardEntriesForTest,
      _setCctvOverlayHostForTest: parts.testing._setCctvOverlayHostForTest,
      createCctvProjectionOverlayEntry:
        parts.projection.createCctvProjectionOverlayEntry,
      getActiveVideoElement: parts.projection.getActiveVideoElement,
      setCctvCardPresentationOptions:
        parts.cards.setCctvCardPresentationOptions,
      surfaceRegimeKey: parts.ground.surfaceRegimeKey,
      normalizeCoverageMode: parts.model.normalizeCoverageMode,
      readCalibrationStoreV2: parts.calibration.readCalibrationStoreV2,
      writeCalibrationStoreV2: parts.calibration.writeCalibrationStoreV2,
      deriveCalBadge: parts.calibration.deriveCalBadge,
      computeFrustumGeometry: parts.geometry.computeFrustumGeometry,
      activationProbeClampRange: parts.geometry.activationProbeClampRange,
      frameSignatureFromPixels: parts.frames.frameSignatureFromPixels,
      _createCctvProjectionPlaneForTest:
        parts.testing._createCctvProjectionPlaneForTest,
      _updateCctvProjectionPlaneForTest:
        parts.testing._updateCctvProjectionPlaneForTest,
      applyCctvFocusDeemphasis: parts.rendering.applyCctvFocusDeemphasis,
      createGeometryProgressNotifier:
        parts.geometryQueue.createGeometryProgressNotifier,
      processCctvGeometryQueueBatch:
        parts.geometryQueue.processCctvGeometryQueueBatch,
      cctvGeometryDrainPacing: parts.geometryQueue.cctvGeometryDrainPacing,
      processCctvGeometryDrainBatch:
        parts.geometryQueue.processCctvGeometryDrainBatch,
      prioritizeActiveCctvGeometryRecord:
        parts.geometryQueue.prioritizeActiveCctvGeometryRecord,
      processGeometryBatch: parts.geometryQueue.processGeometryBatch,
      hideCctvRecordVisuals: parts.rendering.hideCctvRecordVisuals,
      refreshCoverageStyles: parts.rendering.refreshCoverageStyles,
      clearProbeClampOnDeactivation:
        parts.geometry.clearProbeClampOnDeactivation,
      cctvRecordNeedsActivation: parts.model.cctvRecordNeedsActivation,
      bindCctvWorldClickGesture: parts.selection.bindCctvWorldClickGesture,
      setActiveCamera: parts.selection.setActiveCamera,
      deactivateActiveCamera: parts.selection.deactivateActiveCamera,
      cctvEmptyClickDeselects: parts.selection.cctvEmptyClickDeselects,
      materializeCctvCoverageEntities:
        parts.geometry.materializeCctvCoverageEntities,
      materializeCctvActiveCoverageEntities:
        parts.geometry.materializeCctvActiveCoverageEntities,
      materializeCctvVisibleCoverageEntities:
        parts.geometry.materializeCctvVisibleCoverageEntities,
      _extractPickedCameraIdForTest:
        parts.testing._extractPickedCameraIdForTest,
      _setCctvCoverageStateForTest: parts.testing._setCctvCoverageStateForTest,
      focusCctvRecord: parts.navigation.focusCctvRecord,
      maybeAutoHop: parts.navigation.maybeAutoHop,
      cctvCycleIndex: parts.navigation.cctvCycleIndex,
    },
  );
}
export {
  CCTV_CALIBRATION_STORAGE_KEY_V1,
  CCTV_CALIBRATION_STORAGE_KEY_V2,
  FRUSTUM_GROUND_CLEARANCE_M,
  CCTV_FOCUS_RESULT,
  CCTV_PROJECTION_OVERLAY_SOURCE_ID,
  CCTV_PROJECTION_OVERLAY_SOURCE_OPTIONS,
} from './policy.js';

export { createCctvSource } from './source.js';

export { CCTV_AMBIENT_CARD_MAX } from '../../data/cctvLod.js';
export {
  CCTV_OVERLAY_SOURCE_ID,
  createCctvThumbnailOverlayEntry,
  createFrameSlot,
} from '../../data/cctvCards.js';
