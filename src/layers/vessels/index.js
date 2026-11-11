import { createVesselState } from './state.js';
import { createLifecycle } from './lifecycle.js';
import { createIngestion } from './ingestion.js';
import { vesselViewArea } from './cameraArea.js';
import { createVesselSnapshotRenderer } from './snapshotRenderer.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { createTracking } from './tracking.js';
import { createCards } from './cards.js';
import { createTesting } from './testing.js';
import { createEvidence } from './evidence.js';
import { createQueries } from './queries.js';
import { vesselTypeCss } from '../../data/vesselLabels.js';
import { followsClock } from './policy.js';
import { createSnapshotTimeline } from '../../time/snapshotTimeline.js';
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
  parts.testing = createTesting(context);
  parts.evidence = createEvidence(context);
  parts.queries = createQueries(context);
  parts.snapshots = createVesselSnapshotRenderer({
    state: vesselState.state,
    records: vesselState.state.records,
    rendering: parts.rendering,
    tracking: parts.tracking,
    selection: parts.selection,
    cards: parts.cards,
    followsClock: () => followsClock(vesselState),
  });

  parts.ingestion = createIngestion({
    feed: vesselState.state.feed,
    readSource: () => vesselState._source,
    // The viewer, or the renderer's view on an engine without one.
    readViewer: () =>
      vesselState.state.viewer || vesselState.state.renderer?.view || null,
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
      parts.snapshots.reconcileVessels(state.renderer?.view, [], {
        complete: true,
        replace: true,
      });
      state.feed.count = state.records.all.length;
      state.feed.lastUpdate = null;
    },
    resumeLive: () => {
      void parts.ingestion.loadLivePositions(vesselState.state.renderer?.view);
    },
  });
  Object.assign(
    layer,
    parts.queries.methods,
    parts.lifecycle.methods,
    parts.ingestion.methods,
  );
  layer.source = source?.label || 'Vessels';
  Object.assign(layer, {
    applyVesselFocusDeemphasis: parts.rendering.applyVesselFocusDeemphasis,
    buildVesselCard: parts.cards.buildVesselCard,
    buildSelectedVesselCard: parts.cards.buildSelectedVesselCard,
    cardScreenSeparated: parts.cards.cardScreenSeparated,
  });
  Object.defineProperty(layer, 'testing', { value: parts.testing });
  /**
   * What the layer draws, as plain data (the QA probe's drawn(id)): each
   * chevron as the renderer holds it, and the cards published last.
   */
  layer.qaDrawn = () => {
    const { state } = vesselState;
    if (!state.feed.enabled) return null;
    const plain = (p) => (p ? { x: p.x, y: p.y, z: p.z } : null);
    return {
      chevrons: state.records.all
        .map((record) => [record, parts.rendering.getVisual(record).billboard])
        .filter(([, billboard]) => billboard)
        .map(([record, billboard]) => ({
          id: record.id ?? null,
          position: plain(billboard.position),
          show: billboard.show === true,
          rotation: billboard.rotation,
          scale: billboard.scale,
          alpha: billboard.color?.alpha ?? 1,
          depthFree:
            billboard.disableDepthTestDistance === Number.POSITIVE_INFINITY,
          selected: record === state.selectedRecord,
          css:
            record === state.selectedRecord
              ? '#ffffff'
              : vesselTypeCss(record.type),
        })),
      cards: (vesselState._publishedCards ?? []).map((entry) => ({
        id: entry.id,
        selected: entry.selected === true,
        position: plain(entry.position),
      })),
    };
  };
  return layer;
}
export { AIS_FIRST_CONNECT_GRACE_MS } from './policy.js';
export {
  VESSEL_OVERLAY_SOURCE_ID,
  VESSEL_LABEL_GRID_PX,
  VESSEL_DEFAULT_LABEL_LIMIT,
  VESSEL_OVERLAY_MAX_COHORT,
  VESSEL_CARD_FADE_DISTANCE_M,
  normalizeVesselType,
  vesselTypeCss,
  accentForVesselType,
  vesselOverlayCohortLimit,
  applyVesselOverlayPolicy,
} from '../../data/vesselLabels.js';
