import { COLORS as SHARED_COLORS, PROVIDER_COLORS } from '../../policy.js';

/** Identity and tuning for the Mapillary street-level provider. */
export const MAPILLARY_PROVIDER_ID = 'mapillary';
export const MAPILLARY_NAME = 'Mapillary';
export const MAPILLARY_LABEL = 'MAPILLARY';
export const MAPILLARY_KEY_ID = 'mapillary';
export const MAPILLARY_GRAPH_HOST = 'https://graph.mapillary.com';

/** Stable id prefixes for picked primitives; every one starts with `mly:`. */
export const PICK_PREFIX = Object.freeze({
  root: 'mly:',
  sequence: 'mly:seq:',
  image: 'mly:img:',
});

/**
 * Mapillary draws in one colour, its brand green, for lines, overview points
 * and cones alike (360° cones keep their ring shape); selection is GEV cyan.
 */
export const COLORS = Object.freeze({
  coverage: PROVIDER_COLORS.mapillary,
  selected: SHARED_COLORS.selected,
});

/** Camera-driven coverage refresh. */
export const COVERAGE_MOVE_DEBOUNCE_MS = 320;
export const COVERAGE_MAX_TILES = 9;
/** Overview (z0–5) coverage points seen from orbit. */
export const COVERAGE_OVERVIEW_MAX_TILES = 16;
export const COVERAGE_OVERVIEW_POINT_PX = 2.5;
export const COVERAGE_MAX_SEQUENCES = 6000;
export const COVERAGE_LINE_WIDTH_PX = 2.5;

/** Per-sequence image cones after a sequence is selected. */
export const SEQUENCE_IMAGES_LIMIT = 2000;
export const IMAGE_CONE_SIZE_PX = 26;
export const IMAGE_CONE_MIN_SPACING_M = 3;

/** Nearest-image search when the user asks to look at a place. */
export const NEAREST_RADIUS_M = 50;
export const NEAREST_LIMIT = 8;

/**
 * On-globe credit shown while the provider is active. Mapillary imagery and
 * derived data are CC BY-SA 4.0 and require visible attribution.
 */
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
