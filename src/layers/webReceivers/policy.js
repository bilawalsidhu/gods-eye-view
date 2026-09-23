export const WEB_RECEIVERS_LAYER_ID = 'web-receivers';

export const WEB_RECEIVER_PREFIX = 'web-receiver:';

export const CATALOG_ENDPOINT = '/api/web-receivers/catalog';

/** The proxy caches for 30 minutes; refreshing on the same cadence is enough. */
export const CATALOG_REFRESH_MS = 30 * 60 * 1000;

export const CATALOG_FETCH_TIMEOUT_MS = 20_000;

export const GLOBE_INTERACTION_MAX_DISTANCE_M = 30_000_000;

/** Search results are highlighted; more than this and the globe is a mess. */
export const HIGHLIGHT_LIMIT = 12;

export const MARKER_LIFT_M = 30;

export const SELECTED_LIFT_M = 35;

export const FLY_TO_ALTITUDE_M = 180_000;

export const DEFAULT_FILTER = Object.freeze({ type: 'all', band: 'all' });

/** Marker colour per receiver family. */
export const RECEIVER_TYPE_COLORS = Object.freeze({
  kiwisdr: '#63f39a',
  websdr: '#ffb454',
  openwebrx: '#5ec8ff',
});

export const MARKER_OUTLINE_COLOR = '#06131a';
