import { createApplicationCables } from '../app/layers/submarineCables.js';
import { overlayHost } from '../app/layers/overlayHost.js';
import { createCableOverlayPublisher as createPublisher } from '../layers/submarineCables/index.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
export function createTeleGeographySubmarineCableLayer(options = {}) {
  return createApplicationCables({
    source: createBundledCableSource(),
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
