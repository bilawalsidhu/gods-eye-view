import { createVesselState } from './state.js';
import { createLifecycle } from './lifecycle.js';
import { createIngestion } from './ingestion.js';
import { createVesselSnapshotRenderer } from './snapshotRenderer.js';
import { createRendering } from './rendering.js';
import { createSelection } from './selection.js';
import { createTracking } from './tracking.js';
import { createCards } from './cards.js';
import { createTesting } from './testing.js';
import { createEvidence } from './evidence.js';
import { createQueries } from './queries.js';
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
  });

  parts.ingestion = createIngestion({
    feed: vesselState.state.feed,
    readSource: () => vesselState._source,
    readViewer: () => vesselState.state.viewer,
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
    formatTelemetry: parts.cards.formatTelemetry,
    formatTelemetrySummary: parts.cards.formatTelemetrySummary,
    formatHudTelemetry: parts.cards.formatHudTelemetry,
  });
  Object.defineProperty(layer, 'testing', { value: parts.testing });
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
