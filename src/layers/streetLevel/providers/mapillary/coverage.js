import {
  createLineCoverage,
  sequenceIdFromPick as lineSequenceIdFromPick,
} from '../../lineCoverage.js';
import { decodeCoverageTile } from './decode.js';
import {
  coverageZoomForHeight,
  overviewZoomForHeight,
} from '../../tileMath.js';
import {
  COLORS,
  COVERAGE_LINE_WIDTH_PX,
  COVERAGE_MAX_SEQUENCES,
  COVERAGE_MAX_TILES,
  COVERAGE_MOVE_DEBOUNCE_MS,
  COVERAGE_OVERVIEW_MAX_TILES,
  COVERAGE_OVERVIEW_POINT_PX,
  KEY_REJECTED_MESSAGE,
  PICK_PREFIX,
  RATE_LIMITED_MESSAGE,
  SEQUENCE_VIEW_NEAR_M,
  SEQUENCE_VIEW_RANGE_MIN_M,
  SEQUENCE_VIEW_RANGE_PER_HEIGHT,
} from './policy.js';

export { SWAP_MAX_WAIT_MS, meshBoxInRange } from '../../lineCoverage.js';

/** Overview points (z0–5) from orbit, sequence lines (z11–14) below 60 km. */
export function mapillaryZoomFor(heightM) {
  const sequence = coverageZoomForHeight(heightM);
  if (sequence != null) return { zoom: sequence, kind: 'sequence' };
  const overview = overviewZoomForHeight(heightM);
  return overview != null ? { zoom: overview, kind: 'overview' } : null;
}

/** Sequence id for any part's pick id (`mly:seq:<id>[~<part>]`), else null. */
export function sequenceIdFromPick(pickId) {
  return lineSequenceIdFromPick(pickId, PICK_PREFIX.sequence);
}

/** Mapillary's vector-tile coverage through the server proxy. */
export function createCoverage({ state, source }) {
  return createLineCoverage({
    state,
    fetchTile: async (tile, { signal }) =>
      decodeCoverageTile(
        await source.getTile('coverage', tile.z, tile.x, tile.y, { signal }),
        tile,
      ),
    zoomFor: mapillaryZoomFor,
    colors: COLORS,
    pickPrefix: PICK_PREFIX.sequence,
    renderKey: 'mapillary-coverage',
    tuning: {
      maxTiles: COVERAGE_MAX_TILES,
      overviewMaxTiles: COVERAGE_OVERVIEW_MAX_TILES,
      maxSequences: COVERAGE_MAX_SEQUENCES,
      lineWidthPx: COVERAGE_LINE_WIDTH_PX,
      overviewPointPx: COVERAGE_OVERVIEW_POINT_PX,
      moveDebounceMs: COVERAGE_MOVE_DEBOUNCE_MS,
      viewRangeMinM: SEQUENCE_VIEW_RANGE_MIN_M,
      viewRangePerHeight: SEQUENCE_VIEW_RANGE_PER_HEIGHT,
      viewNearM: SEQUENCE_VIEW_NEAR_M,
    },
    messages: {
      keyRejected: KEY_REJECTED_MESSAGE,
      rateLimited: RATE_LIMITED_MESSAGE,
    },
  });
}
