import { createVesselState } from './state.js';
import { createLifecycle } from './lifecycle.js';
import { createIngestion } from './ingestion.js';
import { vesselViewArea } from './cameraArea.js';
import { createVesselSnapshotRenderer } from './snapshotRenderer.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { createTracking } from './tracking.js';
import { createCards } from './cards.js';
import { createPhotos } from './photos.js';
import { createTesting } from './testing.js';
import { createEvidence } from './evidence.js';
import { createQueries } from './queries.js';
import { followsClock } from './policy.js';
import {
  createSnapshotTimeline,
  snapshotAnswer,
} from '../../time/snapshotTimeline.js';
import { worldClock } from '../../time/worldClock.js';
/** Compose one vessel layer with application-owned scene services. */
export function createVesselLayer({ source, services, options = {} } = {}) {
  const vesselState = createVesselState({ source, services });
  const parts = {};
  const layer = {};
  const context = { vesselState, services, parts, layer, options };
  parts.lifecycle = createLifecycle(context);
  parts.rendering = createRendering(context);
  parts.selection = createSelection(context);
  parts.tracking = createTracking(context);
  parts.cards = createCards(context);
  parts.photos = createPhotos(context);
  parts.testing = createTesting(context);
  parts.evidence = createEvidence(context);
  parts.queries = createQueries(context);
  parts.snapshots = createVesselSnapshotRenderer({
    state: vesselState.state,
    placement: services?.placement ?? null,
    rendering: parts.rendering,
    tracking: parts.tracking,
    selection: parts.selection,
    cards: parts.cards,
    followsClock: () => followsClock(vesselState),
  });

  parts.ingestion = createIngestion({
    feed: vesselState.state.feed,
    readSource: () => vesselState._source,
    readViewer: () => vesselState.state.viewer,
    readArea: vesselViewArea,
    getRowLimit: parts.rendering.renderRowLimit,
    readCount: () => vesselState.state.records.all.length,
    applyRows: parts.snapshots.reconcileVessels,
    classifySnapshot: parts.queries.classifyAisFeedSnapshot,
    isDefinitiveTransportFailure: parts.lifecycle.isDefinitiveTransportFailure,
    isGraceEligibleTransport: parts.lifecycle.isGraceEligibleTransport,
    markUnavailable: parts.lifecycle.markAisUnavailable,
    settleFirstConnect: parts.lifecycle.settleFirstConnectPhase,
    now: () => vesselState._aisRuntime.now(),
    setSourceLabel: (source) => {
      layer.source = source;
    },
    followsClock: () => followsClock(vesselState),
    timedAnswer: snapshotAnswer,
    reloadAtClock: () => vesselState.timeline.reload(),
  });
  // Vessels follow the world clock while the source declares a timeline.
  vesselState.timeline = createSnapshotTimeline({
    id: 'ais-live-vessels',
    clock: worldClock,
    source: () => vesselState._source,
    load: (atMs, { signal, replace }) =>
      parts.ingestion.loadAt(atMs, { signal, replace }),
    clear: () => {
      const { state } = vesselState;
      if (state.viewer)
        parts.snapshots.reconcileVessels(state.viewer, [], {
          complete: true,
          replace: true,
        });
      state.feed.count = state.records.all.length;
      state.feed.lastUpdate = null;
    },
    resumeLive: () => parts.ingestion.resumeLive(vesselState.state.viewer),
  });
  Object.assign(
    layer,
    parts.queries.methods,
    parts.lifecycle.methods,
    parts.ingestion.methods,
  );
  layer.source = source?.label || 'Vessels';
  Object.assign(layer, {
    /** The vessel's Open Vessel Photos photo, once its lookup answered. */
    getVesselPhoto: (id) =>
      parts.photos.vesselPhoto(vesselState.state.records.byId.get(id)),
  });
  Object.defineProperty(layer, 'testing', { value: parts.testing });
  return layer;
}
