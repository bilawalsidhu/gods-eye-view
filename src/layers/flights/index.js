import { createFlightSnapshotRenderer } from './snapshotRenderer.js';
import { createFlightState } from './state.js';
import { createRendering } from './rendering.js';
import { createIcons } from './icons.js';
import { createMotion } from './motion.js';
import { createTracking } from './tracking.js';
import { createController } from './controller.js';
import { createEnrichment } from './enrichment.js';
import { createIngestion } from './ingestion.js';
import { createLifecycle } from './lifecycle.js';
import { createEvidence } from './evidence.js';
import { createTesting } from './testing.js';
import { createQueries } from './queries.js';
import { createClockFollow } from './clockFollow.js';
import {
  createSnapshotTimeline,
  snapshotAnswer,
} from '../../time/snapshotTimeline.js';
import { worldClock } from '../../time/worldClock.js';
/** Compose one civil-flight layer with application-owned scene services. */
export function createCivilFlightLayer({
  source,
  services,
  resolveAsset = (url) => url,
} = {}) {
  const flightState = createFlightState({ source, services });
  const parts = {};
  const layer = {};
  const context = { flightState, services, parts, layer, resolveAsset };
  parts.rendering = createRendering(context);
  parts.icons = createIcons(context);
  parts.motion = createMotion(context);
  parts.tracking = createTracking(context);
  parts.controller = createController(context);
  parts.enrichment = createEnrichment(context);
  parts.lifecycle = createLifecycle(context);
  parts.evidence = createEvidence(context);
  parts.testing = createTesting(context);
  parts.queries = createQueries(context);
  parts.clockFollow = createClockFollow(context);
  const applySnapshot = createFlightSnapshotRenderer({
    flightState,
    placement: services.placement ?? null,
    records: flightState.records,
    militaryRegistry: services.militaryRegistry,
    groundFloor: services.groundFloor,
    rendering: parts.rendering,
    tracking: parts.tracking,
    motion: parts.motion,
    icons: parts.icons,
    enrichment: parts.enrichment,
    queries: parts.queries,
  });
  parts.ingestion = createIngestion({
    feed: flightState.feed,
    getQuery: (viewer) =>
      parts.controller._flightQuery(viewer || flightState._viewer),
    applySnapshot: (snapshot, viewer, options) => {
      // At another time the snapshot takes the place of every contact: how
      // each moved belongs to the time the clock left. Back at live too, but
      // the contacts it lacks are kept as they were for it to judge.
      if (options?.replace) parts.clockFollow.resetMotion();
      if (options?.handover) {
        parts.clockFollow.handOverMotion(
          parts.clockFollow.absentAtHandover(snapshot),
        );
      }
      return applySnapshot(snapshot, viewer, options);
    },
    followsClock: () => flightState.timeline.active(),
    timedAnswer: snapshotAnswer,
    setSourceLabel: (source) => {
      layer.source = source;
    },
    applyPendingTrackingRestore: () =>
      parts.tracking._applyPendingTrackingRestore(),
  });

  // Contacts follow the world clock while the source declares a timeline.
  flightState.timeline = createSnapshotTimeline({
    id: 'flights',
    clock: worldClock,
    source: () => flightState.feed._source,
    load: (atMs, { signal, replace }) =>
      parts.ingestion.methods.loadAt(atMs, { signal, replace }),
    clear: () => parts.clockFollow.clear(),
    resumeLive: () => parts.ingestion.methods.resumeLive(flightState._viewer),
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
