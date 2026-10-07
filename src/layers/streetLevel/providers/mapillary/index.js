import { createCoverage, sequenceIdFromPick } from './coverage.js';
import { createSequences } from './sequences.js';
import { createMapillaryViewer } from './viewer.js';
import { passesImageryFilter } from '../../filter.js';
import { metresBetween } from '../../view.js';
import {
  COLORS,
  MAPILLARY_CREDIT_HTML,
  MAPILLARY_KEY_ID,
  MAPILLARY_LABEL,
  MAPILLARY_NAME,
  MAPILLARY_PROVIDER_ID,
  MAPILLARY_SOURCE_METHODS,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  PICK_PREFIX,
} from './policy.js';

/** Per-provider mutable state, created once per `create()`. */
function createProviderState(context) {
  return {
    context,
    services: context.services,
    viewer: null,
    keyRequired: false,
    /** Coverage waits for the first status: no tile requests without a key. */
    statusKnown: false,
    /** Mapillary refused the token: request nothing until re-enabled. */
    keyRejected: false,
    status: null,
    coverage: {
      zoom: null,
      /** Current zoom's tiles by `z/x/y` key. */
      tiles: new Map(),
      /** Previous zoom's tiles, kept on screen until replacements land. */
      stale: new Map(),
      staleTimer: null,
      /** Tile key → its request's controller; any entry means LOADING. */
      pending: new Map(),
      lastError: null,
      /** While Mapillary rate-limits: no requests before this time (ms). */
      holdUntil: 0,
      holdTimer: null,
      debounceTimer: null,
      removeCameraListener: null,
      terrainReady: null,
      hint: '',
      kind: null,
    },
    sequence: {
      selectedId: null,
      images: [],
      /** Recent sequences' thinned images, by sequence id. */
      cache: new Map(),
      collection: null,
      loading: false,
      abort: null,
    },
  };
}

/**
 * Mapillary Street Level provider: tile coverage, Graph API image cones and
 * the MapillaryJS viewer. `source` is ./source.js or a stand-in.
 * @returns {import('../../registry.js').StreetLevelProvider}
 */
export function createMapillaryProvider({ source }) {
  if (
    !MAPILLARY_SOURCE_METHODS.every(
      (method) => typeof source?.[method] === 'function',
    )
  )
    throw new TypeError('A Mapillary source is required');

  return Object.freeze({
    id: MAPILLARY_PROVIDER_ID,
    name: MAPILLARY_NAME,
    label: MAPILLARY_LABEL,
    requiresKeyId: MAPILLARY_KEY_ID,
    pickPrefix: PICK_PREFIX.root,
    colors: COLORS,
    credit: Object.freeze({ html: MAPILLARY_CREDIT_HTML }),

    create(context) {
      const state = createProviderState(context);
      const parts = {};
      parts.coverage = createCoverage({ state, source, parts });
      parts.sequences = createSequences({ state, source, parts });
      const viewer = createMapillaryViewer({
        source,
        render: context.services?.render,
      });

      return {
        async status() {
          try {
            state.status = await source.getStatus();
            state.keyRequired = state.status?.configured !== true;
          } catch {
            state.status = null;
            state.keyRequired = !source.hasToken();
          }
          const first = !state.statusKnown;
          state.statusKnown = true;
          // Coverage held back until now: draw it if the layer is on.
          if (first) parts.coverage.refresh();
          context.notify();
          return { configured: !state.keyRequired };
        },

        init(cesiumViewer) {
          state.viewer = cesiumViewer;
          parts.sequences.ensureCollections(cesiumViewer);
          parts.sequences.setVisible(false);
        },

        activate(cesiumViewer) {
          state.viewer = cesiumViewer;
          parts.sequences.setVisible(true);
          parts.coverage.attach(cesiumViewer);
        },

        deactivate() {
          parts.coverage.detach();
          parts.coverage.clear();
          parts.coverage.resetErrors();
          parts.sequences.clearSelection();
          parts.sequences.setVisible(false);
        },

        destroy(cesiumViewer) {
          parts.coverage.detach();
          parts.coverage.clear();
          parts.coverage.resetErrors();
          parts.sequences.destroy(cesiumViewer);
        },

        refreshCoverage: () => parts.coverage.refresh(),

        /** The filter changed: redraw. Each draw reads it from the context. */
        setFilter() {
          parts.coverage.rebuild();
          parts.sequences.rerender();
        },

        coverageStats() {
          return {
            count: parts.coverage.sequenceCount(),
            zoom: state.coverage.zoom,
            kind: state.coverage.kind,
            loading: state.coverage.pending.size > 0,
            hint: state.coverage.hint,
            error: state.coverage.lastError,
            keyRequired: state.keyRequired,
            keyRejected: state.keyRejected,
          };
        },

        handlePick(pickId) {
          const sequenceId = sequenceIdFromPick(pickId);
          if (sequenceId) {
            parts.sequences.select(sequenceId);
            return true;
          }
          if (pickId.startsWith(PICK_PREFIX.image)) {
            context.actions.openImage(pickId.slice(PICK_PREFIX.image.length));
            return true;
          }
          return false;
        },

        selectSequence: (sequenceId) => parts.sequences.select(sequenceId),
        clearSequence: () => parts.sequences.clearSelection(),
        sequenceStats: () => ({
          selectedId: state.sequence.selectedId,
          images: state.sequence.images.length,
          loading: state.sequence.loading,
        }),

        /**
         * Nearest image that passes the imagery filter, or null. The core
         * aborts `signal` once a newer request overtakes the lookup.
         */
        async nearestImage({ lat, lon }, { signal } = {}) {
          const images = await source.nearestImages(
            { lat, lon, radius: NEAREST_RADIUS_M, limit: NEAREST_LIMIT },
            { signal },
          );
          // The API returns the images in the radius in no particular order.
          const metres = (record) => {
            const [lon2, lat2] = (record.computed_geometry || record.geometry)
              ?.coordinates || [NaN, NaN];
            const d = metresBetween({ lon, lat }, { lon: lon2, lat: lat2 });
            return Number.isFinite(d) ? d : Infinity;
          };
          const byDistance = [...images].sort((a, b) => metres(a) - metres(b));
          const filter = context.getFilter();
          const hit = byDistance.find((record) =>
            passesImageryFilter(
              {
                isPano: record.is_pano === true,
                capturedAt: Number(record.captured_at) || 0,
              },
              filter,
            ),
          );
          return hit ? String(hit.id) : null;
        },

        viewer,
      };
    },
  });
}
