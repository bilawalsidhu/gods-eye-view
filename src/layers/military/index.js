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
import { createClockFollow } from './clockFollow.js';
import { createSnapshotTimeline } from '../../time/snapshotTimeline.js';
import { worldClock } from '../../time/worldClock.js';
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
  parts.clockFollow = createClockFollow(context);
  const applySnapshot = createMilitarySnapshotRenderer({
    flightState,
    records: flightState.records,
    groundFloor: services.groundFloor,
    meshFloor: services.meshFloor,
    militaryRegistry: services.militaryRegistry,
    rendering: parts.rendering,
    tracking: parts.tracking,
    motion: parts.motion,
    queries: parts.queries,
  });
  parts.ingestion = createIngestion({
    feed: flightState.feed,
    applySnapshot: (snapshot, viewer, options) => {
      if (options?.replace) parts.clockFollow.resetMotion();
      return applySnapshot(snapshot, viewer, options);
    },
    followsClock: () => flightState.timeline.active(),
    setSourceLabel: (source) => {
      layer.source = source;
    },
    applyPendingTrackingRestore: () =>
      parts.tracking._applyPendingTrackingRestore(),
  });

  // Contacts follow the world clock while the source declares a timeline.
  flightState.timeline = createSnapshotTimeline({
    id: 'military',
    clock: worldClock,
    source: () => flightState.feed._source,
    load: (atMs, { signal, replace }) =>
      parts.ingestion.methods.loadAt(atMs, { signal, replace }),
    clear: () => parts.clockFollow.clear(),
    resumeLive: () => {
      layer.update(flightState._viewer).catch(() => {});
    },
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
