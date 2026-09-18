import { createMilitarySnapshotRenderer } from './snapshotRenderer.js';
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
  parts.lifecycle = createLifecycle(context);
  parts.testing = createTesting(context);
  parts.queries = createQueries(context);
  const applySnapshot = createMilitarySnapshotRenderer({
    flightState,
    records: flightState.records,
    groundFloor: services.groundFloor,
    meshFloor: services.meshFloor,
    militaryRegistry: services.militaryRegistry,
    rendering: parts.rendering,
    tracking: parts.tracking,
    queries: parts.queries,
  });
  parts.ingestion = createIngestion({
    feed: flightState.feed,
    getQuery: (viewer) =>
      parts.controller._militaryQuery(viewer || flightState._viewer),
    applySnapshot,
    setSourceLabel: (source) => {
      layer.source = source;
    },
    applyPendingTrackingRestore: () =>
      parts.tracking._applyPendingTrackingRestore(),
  });

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
