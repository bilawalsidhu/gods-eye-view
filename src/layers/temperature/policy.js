export const LAYER_ID = 'surface-temperature';

/**
 * MODIS Terra daytime land-surface temperature, monthly mean.
 *
 * The layer is a year of these, played back. A month is long enough to fill
 * the swath and cloud gaps a single day leaves, and twelve of them show the
 * seasonal cycle — the thing a temperature map over time is for.
 *
 * GIBS bakes the colour ramp into the PNG — cold blues through hot reds — so
 * the globe gets a real heat map without the client inventing a scale.
 */
export const GIBS_LAYER = 'MODIS_Terra_L3_Land_Surface_Temp_Monthly_Day';

export const GIBS_TILE_MATRIX_SET = 'GoogleMapsCompatible_Level6';

/**
 * Deepest level GoogleMapsCompatible_Level6 defines, read from the EPSG:3857
 * capabilities: levels 0..6, 256 px tiles. The monthly product is published on
 * this set only; asking it for level 7 answers 400 on every tile.
 */
export const GIBS_MAX_LEVEL = 6;

/** First published month of the product, from its capabilities time range. */
export const FIRST_MONTH = '2000-03-01';

/** First year on the year scale. */
export const FIRST_YEAR = Number(FIRST_MONTH.slice(0, 4));

/**
 * How many months back to look for the newest published mean.
 *
 * GIBS answers an unpublished month with 404, and the newest monthly mean
 * trails the calendar by one to two months.
 */
export const LATEST_LOOKBACK_MONTHS = 4;

/** Deadline for one availability probe before it is treated as unavailable. */
export const PROBE_TIMEOUT_MS = 8000;

/** Probe tile used to decide whether a candidate month is published. */
export const PROBE_TILE = Object.freeze({ level: 2, row: 1, col: 2 });

/** Availability probes in flight at once while resolving a year. */
export const PROBE_CONCURRENCY = 6;

export const DEFAULT_ALPHA = 0.7;

export const MIN_ALPHA = 0.1;

export const MAX_ALPHA = 1;

/**
 * The retrieval is a clear-sky land product: cloud and water carry no value and
 * arrive transparent. Say so rather than letting a gap read as "temperate".
 */
export const COVERAGE_NOTE =
  'monthly clear-sky land average; cloud-persistent areas and water carry no value';

/**
 * NASA's published colour map for this product, the document the layer's WMTS
 * capabilities entry points at. Note the name is the product family, not the
 * layer id. Fetched at first sample and parsed once; it is what makes a pixel
 * readable as a temperature rather than a guess.
 */
export const COLORMAP_URL =
  'https://gibs.earthdata.nasa.gov/colormaps/v1.0/MODIS_Land_Surface_Temp.xml';

/**
 * Longest a year's frames wait for their tiles before they are shown anyway.
 *
 * A busy globe (terrain or another layer still streaming) can hold
 * `tilesLoaded` false long after these frames' own tiles arrived, and playback
 * must not stall on work that is not its own.
 */
export const PRELOAD_TIMEOUT_MS = 20000;

/** Time each month occupies at play speed; a full year loops in about 19 s. */
export const MONTH_DURATION_MS = 1600;

/**
 * Share of each month spent blending into the next. The rest is a hold, so a
 * month is readable before it starts to change rather than always mid-blend.
 */
export const CROSSFADE_SHARE = 0.6;

/** Duration of a glide to a clicked month. */
export const SEEK_DURATION_MS = 450;

/** Sampled tiles held in memory: a pinned point re-read through a year. */
export const SAMPLE_TILE_CACHE_MAX = 24;

/** Marker for the sampled point, distinct from the overlay it reads. */
export const SAMPLE_MARKER_COLOR = '#ffffff';
