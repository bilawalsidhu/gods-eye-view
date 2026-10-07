import { COLORS as SHARED_COLORS } from '../../policy.js';

/** Identity and tuning for Street Level's Mapillary imagery. */
export const MAPILLARY_KEY_ID = 'mapillary';
export const MAPILLARY_GRAPH_HOST = 'https://graph.mapillary.com';

/** Methods a source (./source.js or a stand-in) must have. */
export const MAPILLARY_SOURCE_METHODS = Object.freeze([
  'getStatus',
  'getTile',
  'getSequenceImages',
  'nearestImages',
]);

/** Stable id prefixes for picked primitives; every one starts with `mly:`. */
export const PICK_PREFIX = Object.freeze({
  root: 'mly:',
  sequence: 'mly:seq:',
  image: 'mly:img:',
});

/** Mapillary green for lines, cones and the legend; GEV cyan for selection. */
export const COLORS = Object.freeze({
  coverage: '#05cb63',
  selected: SHARED_COLORS.selected,
});

/** Camera-driven coverage refresh. */
export const COVERAGE_MOVE_DEBOUNCE_MS = 320;
export const COVERAGE_MAX_TILES = 9;
/** Shown when Mapillary refuses the server's token (401/403). */
export const KEY_REJECTED_MESSAGE =
  'Mapillary rejected MAPILLARY_CLIENT_TOKEN — replace it in Provider Settings';
/** Shown while Mapillary rate-limits tile requests (429). */
export const RATE_LIMITED_MESSAGE =
  'Coverage requests are being rate-limited — they resume on their own';
/**
 * Street-zoom coverage reaches this far from the camera: camera height times
 * the factor, never below the floor, even when a tilted view sees further.
 */
export const SEQUENCE_VIEW_RANGE_MIN_M = 2_500;
export const SEQUENCE_VIEW_RANGE_PER_HEIGHT = 10;
export const COVERAGE_MAX_SEQUENCES = 6000;
export const COVERAGE_LINE_WIDTH_PX = 2.5;

/** Per-sequence image cones after a sequence is selected. */
export const SEQUENCE_IMAGES_LIMIT = 2000;
export const IMAGE_CONE_SIZE_PX = 26;
export const IMAGE_CONE_MIN_SPACING_M = 3;

/** Nearest-image search radius in metres (the graph API caps it at 50 m). */
export const NEAREST_RADIUS_M = 50;
/** Images asked for in a nearest-image search. */
export const NEAREST_LIMIT = 8;

/** On-globe credit: Mapillary imagery is CC BY-SA 4.0 and needs attribution. */
export const MAPILLARY_CREDIT_HTML =
  'Street Level: imagery © <a href="https://www.mapillary.com" target="_blank" rel="noopener">Mapillary</a> contributors, CC BY-SA 4.0';

/** Deep link to an image on mapillary.com, as the web app shares them. */
export function mapillaryImageUrl(imageId) {
  const id = String(imageId || '').trim();
  if (!id) return 'https://www.mapillary.com/app/';
  return `https://www.mapillary.com/app/?pKey=${encodeURIComponent(id)}&focus=photo`;
}

/** Fields requested from the graph API. */
export const IMAGE_FIELDS =
  'id,captured_at,compass_angle,computed_compass_angle,geometry,computed_geometry,computed_altitude,is_pano,sequence,thumb_256_url,creator,quality_score';
export const SEQUENCE_IMAGE_FIELDS =
  'id,captured_at,compass_angle,geometry,is_pano,computed_altitude';
