import { createDirectionsSource } from '../layers/directions/source.js';
/**
 * @module directions
 * @description Service bundle for the Directions layer.
 *
 * The layer itself lives in `src/layers/directions/` and draws through the
 * globe contract (its render/display.js). This module is the one place that
 * names the application's shared services — the render governor, the pick
 * registry, the ground pick, the world overlay, the camera verbs, the shared
 * ground floor and the pointer arbiter — and it re-exports the layer's pure
 * helpers for the tests and the share-link code.
 */

import * as credits from './dataCredits.js';
import * as render from '../renderGovernor.js';
import * as picking from './pickRegistry.js';
import * as scenePick from './scenePick.js';
import { worldOverlayFor as overlays } from '../overlays/worldOverlay.js';
import * as camera from '../cameraVerbs.js';
import * as ground from './groundFloor.js';
import * as input from './inputOwnership.js';
import { createDirectionsLayer } from '../layers/directions/index.js';

/** The shared scene owners every Directions instance runs on. */
const directionsServices = Object.freeze({
  credits,
  render,
  picking,
  scenePick,
  overlays,
  camera,
  ground,
  input,
});

/** Construct one Directions layer over the application scene owners. */
export function createApplicationDirectionsLayer({
  source = createDirectionsSource(),
  createRenderer,
  groundFloor = ground,
} = {}) {
  return createDirectionsLayer({
    services: { ...directionsServices, ground: groundFloor },
    source,
    createRenderer,
  });
}

export {
  DEFAULT_DIRECTIONS_MODE,
  DIRECTIONS_MODES,
  DIRECTIONS_POINTER_OWNER,
  DIRECTIONS_ROUTE_COLOR,
  POINTER_TOOL_EXITS,
  STEP_ANCHOR_DEADLINE_MS,
  STEP_ANCHOR_FAST_ATTEMPTS,
  STEP_ANCHOR_RETRY_MS,
  STEP_ANCHOR_SLOW_RETRY_MS,
  createDirectionsStepOverlayEntry,
  directionsRequestUrl,
  directionsRowControls,
  directionsStats,
  directionsStepCopy,
  directionsStepList,
  normalizeDirectionsParams,
  normalizeRoutePayload,
  pointerBlockedMessage,
  stepAnchorDelayMs,
  stepIndexAtDistance,
  stepMarkerHeightM,
  stepMarkerIndices,
} from '../layers/directions/index.js';
