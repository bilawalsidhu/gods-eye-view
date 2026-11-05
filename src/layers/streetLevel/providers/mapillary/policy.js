import { COLORS as SHARED_COLORS, PROVIDER_COLORS } from '../../policy.js';

// Reached by source.js (no browser globals, see check:boundaries), so no
// i18n import: the messages stay English data, translated where shown.
const msg = (text) => text;

/** Identity and tuning for the Mapillary street-level provider. */
export const MAPILLARY_PROVIDER_ID = 'mapillary';
export const MAPILLARY_NAME = 'Mapillary';
export const MAPILLARY_LABEL = 'MAPILLARY';
export const MAPILLARY_KEY_ID = 'mapillary';
export const MAPILLARY_GRAPH_HOST = 'https://graph.mapillary.com';

/** What the provider needs from its source (source.js or a stand-in). */
export const MAPILLARY_SOURCE_METHODS = Object.freeze([
  'getStatus',
  'getTile',
  'getSequenceImages',
]);

/** Stable id prefixes for picked primitives; every one starts with `mly:`. */
export const PICK_PREFIX = Object.freeze({
  root: 'mly:',
  sequence: 'mly:seq:',
  image: 'mly:img:',
});

/** Mapillary green for lines and cones; GEV cyan for the selection. */
export const COLORS = Object.freeze({
  coverage: PROVIDER_COLORS.mapillary,
  selected: SHARED_COLORS.selected,
});

/** Shown when Mapillary refuses the server's token (401/403). */
export const KEY_REJECTED_MESSAGE = msg(
  'Mapillary rejected MAPILLARY_CLIENT_TOKEN — replace it in Provider Settings',
);
/** Shown while Mapillary rate-limits tile requests (429). */
export const RATE_LIMITED_MESSAGE = msg(
  'Coverage requests are being rate-limited — they resume on their own',
);

/** Coverage tuning (see LineCoverageTuning in lineCoverage.js). */
export const COVERAGE_TUNING = Object.freeze({
  maxTiles: 9,
  maxSequences: 6000,
  lineWidthPx: 2.5,
  moveDebounceMs: 320,
  /**
   * Street-zoom coverage reaches this far from the camera: camera height
   * times the factor, never below the floor, even when a tilted view sees
   * further.
   */
  viewRangeMinM: 2_500,
  viewRangePerHeight: 10,
});

/** Per-sequence image cones after a sequence is selected. */
export const SEQUENCE_IMAGES_LIMIT = 2000;

/** On-globe credit: Mapillary imagery is CC BY-SA 4.0 and needs attribution. */
export const MAPILLARY_CREDIT_HTML =
  'Street Level: imagery © <a href="https://www.mapillary.com" target="_blank" rel="noopener">Mapillary</a> contributors, CC BY-SA 4.0';

/** Deep link to an image on mapillary.com, as the web app shares them. */
export function mapillaryImageUrl(imageId) {
  const id = String(imageId || '').trim();
  if (!id) return 'https://www.mapillary.com/app/';
  return `https://www.mapillary.com/app/?pKey=${encodeURIComponent(id)}&focus=photo`;
}

/** Fields requested for a sequence's images. */
export const SEQUENCE_IMAGE_FIELDS =
  'id,captured_at,compass_angle,geometry,is_pano';
