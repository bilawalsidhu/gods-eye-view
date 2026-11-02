import {
  createLineCoverage,
  freshCoverage,
  sequenceIdFromPick,
} from '../../lineCoverage.js';
import { createSequenceCones, thinImages } from '../../sequenceCones.js';
import { coverageZoomForHeight } from '../../tileMath.js';
import { decodeCoverageTile } from './decode.js';
import { createMapillaryViewer } from './viewer.js';
import {
  COLORS,
  COVERAGE_TUNING,
  KEY_REJECTED_MESSAGE,
  MAPILLARY_CREDIT_HTML,
  MAPILLARY_KEY_ID,
  MAPILLARY_LABEL,
  MAPILLARY_NAME,
  MAPILLARY_PROVIDER_ID,
  MAPILLARY_SOURCE_METHODS,
  PICK_PREFIX,
  RATE_LIMITED_MESSAGE,
} from './policy.js';

/** Normalize a graph image record into the shape the cones use. */
function normalizeSequenceImage(record) {
  const coordinates = record?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  return {
    id: String(record.id),
    lon: Number(coordinates[0]),
    lat: Number(coordinates[1]),
    compassAngle: Number(record.compass_angle) || 0,
    capturedAt: Number(record.captured_at) || 0,
    isPano: record.is_pano === true,
  };
}

/** Per-provider mutable state; coverage and cones share it. */
function createProviderState(context) {
  return {
    context,
    services: context.services,
    viewer: null,
    coverage: freshCoverage(),
    sequence: {
      selectedId: null,
      images: [],
      collection: null,
      loading: false,
      /** Why the selected sequence's images could not load, until it goes. */
      error: null,
      abort: null,
    },
  };
}

/**
 * The Mapillary provider: coverage lines from vector tiles, image cones from
 * the Graph API and the MapillaryJS viewer.
 * @param {{source: object, photoViewer?: object}} options  `source` is
 *   source.js or a stand-in; `photoViewer` stands in for the viewer adapter.
 * @returns {import('../../registry.js').StreetLevelProvider}
 */
export function createMapillaryProvider({ source, photoViewer = null }) {
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
      parts.coverage = createLineCoverage({
        state,
        fetchTile: async (tile, { signal }) =>
          decodeCoverageTile(
            await source.getTile('coverage', tile.z, tile.x, tile.y, {
              signal,
            }),
            tile,
          ),
        zoomFor: coverageZoomForHeight,
        colors: COLORS,
        pickPrefix: PICK_PREFIX.sequence,
        renderKey: 'mapillary-coverage',
        tuning: COVERAGE_TUNING,
        messages: {
          keyRejected: KEY_REJECTED_MESSAGE,
          rateLimited: RATE_LIMITED_MESSAGE,
        },
      });
      parts.sequences = createSequenceCones({
        state,
        async loadImages(sequenceId, { signal }) {
          const records = await source.getSequenceImages(sequenceId, {
            signal,
          });
          return thinImages(
            records
              .map(normalizeSequenceImage)
              .filter(Boolean)
              .sort((a, b) => a.capturedAt - b.capturedAt),
          );
        },
        colors: COLORS,
        pickPrefix: PICK_PREFIX.image,
        spriteId: 'street-level:mapillary-cones',
        renderKey: 'mapillary-sequence',
        onHighlight: (sequenceId) => parts.coverage.highlight(sequenceId),
      });

      return {
        /** Coverage waits for the answer: no tile requests without a key. */
        async status({ signal } = {}) {
          let configured;
          try {
            configured =
              (await source.getStatus({ signal }))?.configured === true;
          } catch {
            configured = source.hasToken?.() === true;
          }
          parts.coverage.setKeyStatus(configured);
          return { configured };
        },

        init(viewer) {
          state.viewer = viewer;
          parts.sequences.ensureCollections(viewer);
          parts.sequences.setVisible(false);
        },

        activate(viewer) {
          state.viewer = viewer;
          parts.sequences.setVisible(true);
          parts.coverage.attach(viewer);
        },

        /** Clear lines and cones, forget refusals. */
        deactivate() {
          parts.coverage.detach();
          parts.coverage.clear();
          parts.coverage.unblock();
          parts.sequences.clearSelection();
          parts.sequences.setVisible(false);
        },

        destroy(viewer) {
          parts.coverage.detach();
          parts.coverage.clear();
          parts.sequences.destroy(viewer);
        },

        /** The filter changed: redraw. Each draw reads it from the context. */
        setFilter() {
          parts.coverage.rebuild();
          parts.sequences.rerender();
        },

        coverageStats: () => parts.coverage.stats(),

        /** A line selects its sequence; a cone opens its image. */
        handlePick(pickId) {
          const sequenceId = sequenceIdFromPick(pickId, PICK_PREFIX.sequence);
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
          error: state.sequence.error,
        }),

        viewer:
          photoViewer ||
          createMapillaryViewer({ source, render: context.services?.render }),
      };
    },
  });
}
