import { createCoverage } from './coverage.js';
import { createSequences } from './sequences.js';
import { createMapillaryViewer } from './viewer.js';
import { passesImageryFilter } from '../../filter.js';
import {
  COLORS,
  MAPILLARY_CREDIT_HTML,
  MAPILLARY_KEY_ID,
  MAPILLARY_LABEL,
  MAPILLARY_LEGEND,
  MAPILLARY_NAME,
  MAPILLARY_PROVIDER_ID,
  NEAREST_LIMIT,
  NEAREST_RADIUS_M,
  PICK_PREFIX,
  mapillaryImageUrl,
} from './policy.js';

export { MAPILLARY_PROVIDER_ID, mapillaryImageUrl } from './policy.js';

const SOURCE_METHODS = [
  'getStatus',
  'getTile',
  'getImage',
  'getSequenceImages',
  'nearestImages',
];

/** Per-provider mutable state, created once per `create()`. */
function createProviderState(context) {
  return {
    context,
    services: context.services,
    viewer: null,
    keyRequired: false,
    status: null,
    filter: context.getFilter(),
    coverage: {
      zoom: null,
      /** @type {Map<string, {primitive: object|null, sequences: Map<string, object>, count: number}>} */
      tiles: new Map(),
      /** Tiles from the previous zoom, kept on screen until replacements land. */
      stale: new Map(),
      staleTimer: null,
      pending: new Map(),
      loading: 0,
      lastError: null,
      debounceTimer: null,
      removeCameraListener: null,
      terrainReady: null,
      hint: '',
      kind: null,
    },
    sequence: {
      selectedId: null,
      images: [],
      /** @type {Map<string, Array<object>>} recent sequences' thinned images */
      cache: new Map(),
      collection: null,
      loading: false,
      abort: null,
    },
  };
}

/**
 * Mapillary as a Street Level provider: coverage from cached vector tiles,
 * per-sequence image cones from the Graph API and the MapillaryJS viewer.
 * @param {{source: object}} options  A source from ./source.js (or a stand-in with the same methods).
 * @returns {import('../../registry.js').StreetLevelProvider}
 */
export function createMapillaryProvider({ source }) {
  if (!SOURCE_METHODS.every((method) => typeof source?.[method] === 'function'))
    throw new TypeError('A Mapillary source is required');

  return Object.freeze({
    id: MAPILLARY_PROVIDER_ID,
    name: MAPILLARY_NAME,
    label: MAPILLARY_LABEL,
    requiresKeyId: MAPILLARY_KEY_ID,
    pickPrefix: PICK_PREFIX.root,
    colors: COLORS,
    credit: Object.freeze({
      key: MAPILLARY_PROVIDER_ID,
      html: MAPILLARY_CREDIT_HTML,
    }),
    capabilities: Object.freeze({
      coverage: 'tiles',
      sequences: true,
      pano: true,
      capturedAt: true,
      creator: true,
      follow: true,
    }),
    legend: MAPILLARY_LEGEND,
    externalUrl: mapillaryImageUrl,

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
          parts.sequences.clearSelection();
          parts.sequences.setVisible(false);
        },

        destroy(cesiumViewer) {
          parts.coverage.detach();
          parts.coverage.clear();
          parts.sequences.destroy(cesiumViewer);
        },

        refreshCoverage: () => parts.coverage.refresh(),

        setFilter(filter) {
          state.filter = filter;
          parts.coverage.rebuild();
          parts.sequences.rerender();
        },

        coverageStats() {
          return {
            count: parts.coverage.sequenceCount(),
            zoom: state.coverage.zoom,
            kind: state.coverage.kind,
            loading: state.coverage.loading > 0,
            hint: state.coverage.hint,
            error: state.coverage.lastError,
            keyRequired: state.keyRequired,
          };
        },

        handlePick(pickId) {
          if (pickId.startsWith(PICK_PREFIX.sequence)) {
            parts.sequences.select(pickId.slice(PICK_PREFIX.sequence.length));
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

        /** Nearest image that passes the imagery filter, or null. */
        async nearestImage({ lat, lon }) {
          const images = await source.nearestImages({
            lat,
            lon,
            radius: NEAREST_RADIUS_M,
            limit: NEAREST_LIMIT,
          });
          const hit = images.find((record) =>
            passesImageryFilter(
              {
                isPano: record.is_pano === true,
                capturedAt: Number(record.captured_at) || 0,
              },
              state.filter,
            ),
          );
          return hit ? String(hit.id) : null;
        },

        viewer,
      };
    },
  });
}
