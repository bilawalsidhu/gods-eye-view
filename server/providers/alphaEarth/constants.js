/**
 * AlphaEarth Foundations Satellite Embedding V1 (annual) — Source Cooperative
 * mirror constants. The mirror is keyless, CORS-open and serves byte ranges.
 * See https://source.coop/tge-labs/aef for the layout these values describe.
 */

export const ALPHA_EARTH_DATA_ROOT =
  'https://data.source.coop/tge-labs/aef/v1/annual';
export const ALPHA_EARTH_INDEX_URL = `${ALPHA_EARTH_DATA_ROOT}/aef_index.parquet`;
/** The index records object-store paths; the HTTPS mirror serves the same keys. */
export const ALPHA_EARTH_S3_PREFIX =
  's3://us-west-2.opendata.source.coop/tge-labs/aef/';
export const ALPHA_EARTH_HTTPS_PREFIX =
  'https://data.source.coop/tge-labs/aef/';

export const ALPHA_EARTH_ATTRIBUTION =
  'The AlphaEarth Foundations Satellite Embedding dataset is produced by Google and Google DeepMind.';
export const ALPHA_EARTH_LICENSE = 'CC-BY-4.0';

export const ALPHA_EARTH_BANDS = 64;
/** Native ground sample distance of overview level 0, metres. */
export const ALPHA_EARTH_BASE_METERS = 10;
/** Every COG uses 1024 px tiles at every overview level. */
export const ALPHA_EARTH_TILE_PX = 1024;
/** Each COG is 8192 px square at level 0. */
export const ALPHA_EARTH_COG_PX = 8192;
/** Coarsest level worth reading (1280 m pixels, 64 px per COG). */
export const ALPHA_EARTH_MAX_LEVEL = 7;
/**
 * Observed mean ZSTD size of one band tile (1024² int8). Used only to estimate
 * the byte cost of a request before choosing an overview level.
 */
export const ALPHA_EARTH_BAND_TILE_BYTES = 800 * 1024;

/** Largest accepted box side, kilometres. Coarse levels keep this affordable. */
export const ALPHA_EARTH_MAX_BOX_KM = 100;
/** Output grid cap per side, pixels. */
export const ALPHA_EARTH_MAX_GRID_PX = 1024;

export const ALPHA_EARTH_NODATA_INT8 = -128;
/** Quantised change grid: 0..254 maps 1 − cosine 0..1, 255 is no data. */
export const ALPHA_EARTH_GRID_NODATA = 255;
export const ALPHA_EARTH_GRID_SCALE = 254;
/** Default "changed" threshold on 1 − cosine similarity. */
export const ALPHA_EARTH_DEFAULT_THRESHOLD = 0.35;
