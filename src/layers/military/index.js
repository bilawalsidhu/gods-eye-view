import { createFlightState } from './state.js';
import { createRendering } from './rendering.js';
import { createMotion } from './motion.js';
import { createTracking } from './tracking.js';
import { createController } from './controller.js';
import { createIngestion } from './ingestion.js';
import { createLifecycle } from './lifecycle.js';
import { createTesting } from './testing.js';
import { createQueries } from './queries.js';
/** Compose one military-flight layer with application-owned scene services. */
export function createMilitaryFlightLayer({
  source,
  services,
  resolveAsset = (url) => url,
} = {}) {
  const flightState = createFlightState({ source, services });
  const parts = {};
  const layer = {};
  const context = { flightState, services, parts, layer, resolveAsset };
  parts.rendering = createRendering(context);
  parts.motion = createMotion(context);
  parts.tracking = createTracking(context);
  parts.controller = createController(context);
  parts.ingestion = createIngestion(context);
  parts.lifecycle = createLifecycle(context);
  parts.testing = createTesting(context);
  parts.queries = createQueries(context);
  Object.assign(
    layer,
    parts.queries.methods,
    parts.lifecycle.methods,
    parts.ingestion.methods,
  );
  Object.defineProperty(layer, 'testing', { value: parts.testing });
  return layer;
}
export { TRACKED_MODEL_MAX_PX } from './policy.js';
