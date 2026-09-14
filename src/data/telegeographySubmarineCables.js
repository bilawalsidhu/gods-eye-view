import * as Cesium from 'cesium';
import {
  createSubmarineCableLayer,
  createCableOverlayPublisher as createPublisher,
} from '../layers/submarineCables/index.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
const overlayHost = Object.freeze({
  clearSource: clearOverlaySource,
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
});
export function createTeleGeographySubmarineCableLayer(options = {}) {
  return createSubmarineCableLayer({
    source: createBundledCableSource(),
    overlayHost,
    screenSpaceEventHandlerFactory: (canvas) =>
      new Cesium.ScreenSpaceEventHandler(canvas),
    mapStackEventTarget: typeof window !== 'undefined' ? window : null,
    ...options,
  });
}
export function createCableOverlayPublisher(options = {}) {
  return createPublisher({ host: overlayHost, ...options });
}
export {
  CABLE_REFERENCE_LABEL_WINNER_CAP,
  CABLE_OVERLAY_SOURCE_ID,
  CABLE_OVERLAY_COLLISION_CAPACITY,
  CABLE_STEM_TIP_EPSILON_M,
  CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
  CABLE_SWEEP_MOTION_EPSILON_M,
  CABLE_LABEL_DEPTH_DECISION,
  selectCableReferenceLabelWinners,
  cableReferencePriority,
  createCableOverlayEntry,
  cableClassificationTypeForStack,
  cableClassificationTypeForScene,
  applyTranslucentMarkerBlend,
  createCableReferenceSweepGate,
  updateCableReferenceStem,
} from '../layers/submarineCables/index.js';
export default createTeleGeographySubmarineCableLayer();
