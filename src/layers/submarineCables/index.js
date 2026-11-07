import { createCableSessionLayer } from './session.js';
import { createCablesDisplay } from './render/display.js';
import { defaultSweepClock } from './policy.js';

/**
 * The submarine cable layer on any globe engine: the dataset is read once
 * per activation (session.js) and drawn by `createDisplay(engine)`, by
 * default the contract display (render/display.js).
 */
export function createSubmarineCableLayer({
  source,
  overlayHost,
  mapStackEventTarget = null,
  sweepClock = defaultSweepClock,
  createDisplay = (engine) =>
    createCablesDisplay(engine, {
      overlayHost,
      mapStackEventTarget,
      sweepClock,
    }),
}) {
  if (!source?.fetch || !source.label)
    throw new TypeError(
      'A cable source with a label and fetch(signal) is required',
    );
  return createCableSessionLayer({ source, createDisplay });
}
export { createCableSessionLayer } from './session.js';
export { createCablesDisplay } from './render/display.js';
export {
  selectCableReferenceLabelWinners,
  cableReferencePriority,
  createCableOverlayEntry,
  createCableOverlayPublisher,
  createCableReferenceSweepGate,
  updateCableReferenceTip,
} from './overlay.js';
export { cableDrapeForStack, cableDrapeForEngine } from './surface.js';
export {
  CABLE_REFERENCE_LABEL_WINNER_CAP,
  CABLE_OVERLAY_SOURCE_ID,
  CABLE_OVERLAY_COLLISION_CAPACITY,
  CABLE_STEM_TIP_EPSILON_M,
  CABLE_SWEEP_MOTION_PROBE_INTERVAL_MS,
  CABLE_SWEEP_MOTION_EPSILON_M,
  CABLE_LABEL_DEPTH_DECISION,
} from './policy.js';
