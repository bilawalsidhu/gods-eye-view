/**
 * @module directions
 * @description Service bundle for the Directions layer.
 *
 * The layer itself lives in `src/layers/directions/`, which imports nothing
 * but Cesium and the pure step formatter. This module is the one place that
 * names the application's shared services — the render governor, sprite order,
 * the pick registry, the world overlay, the annotation material, the camera
 * verbs, the shared ground floor and the pointer arbiter — and it re-exports
 * the layer's pure helpers for the tests and the share-link code.
 */

import * as render from '../renderGovernor.js';
import * as sprites from './spriteOrder.js';
import * as picking from './pickRegistry.js';
import * as scenePick from './scenePick.js';
import * as overlays from '../overlays/worldOverlay.js';
import * as annotations from '../annotations/worldAnnotationRenderer.js';
import * as camera from '../cameraVerbs.js';
import * as ground from './groundFloor.js';
import * as input from './inputOwnership.js';
import { createDirectionsLayer } from '../layers/directions/index.js';

/** The shared scene owners every Directions instance runs on. */
export const directionsServices = Object.freeze({
  render,
  sprites,
  picking,
  scenePick,
  overlays,
  annotations,
  camera,
  ground,
  input,
});

/** Construct one Directions layer over the application scene owners. */
export function createApplicationDirectionsLayer() {
  return createDirectionsLayer({ services: directionsServices });
}

export {
  DEFAULT_DIRECTIONS_MODE,
  DIRECTIONS_MODES,
  DIRECTIONS_POINTER_OWNER,
  DIRECTIONS_ROUTE_COLOR,
  DIRECTIONS_STEP_OVERLAY_SOURCE_ID,
  DIRECTIONS_STEP_OVERLAY_SOURCE_OPTIONS,
  FLIGHT_PROGRESS_MS,
  POINTER_TOOL_EXITS,
  STEP_ANCHOR_DEADLINE_MS,
  STEP_ANCHOR_FAST_ATTEMPTS,
  STEP_ANCHOR_RETRY_MS,
  STEP_ANCHOR_SLOW_RETRY_MS,
  createDirectionsLayer,
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
