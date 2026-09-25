/**
 * @file World News layer — headlines pinned at the place named in their
 * title, fetched through the `/api/world-news` proxy (bring your own World
 * News API key; the proxy answers 503 {error:'no_key'} without one and the
 * layer reports `keyRequired` instead of failing).
 *
 * Only the contract fields reach the browser: id, title, url, domain,
 * timestamps, the provider's sentiment score, category, language, source
 * country and ONE place named in the headline. No article text, summaries,
 * images, authors or person/organization entities — ever. Pins mark where
 * a headline is about, not where it was published.
 *
 * @module layers/worldNews/policy
 */

export const LAYER_ID = 'world-news';
export const LAYER_NAME = 'World News';
export const LAYER_ICON = '📰';
export const SOURCE_LABEL = 'World News API · LIVE';

/** Key-registry id (src/keySetupCore.mjs) the panel names when the key is absent. */
export const KEY_ID = 'world-news';

export const API_URL = '/api/world-news';
export const MORE_URL = '/api/world-news/more';

/** Client poll interval; the proxy's 30 min TTL is what guards upstream quota. */
export const REFRESH_INTERVAL_MS = 10 * 60_000;

export const WORLD_NEWS_OVERLAY_SOURCE_ID = 'world-news';
export const OVERLAY_COHORT_LIMIT = 48;
export const OVERLAY_COLLISION_CAPACITY = 24;

/** Render cap on place groups; groups are newest-first so the cap drops the oldest. */
export const MAX_RENDERED_PLACES = 400;

/** Sentiment bands: at or below the first is negative, at or above the second positive. */
export const TONE_NEGATIVE_MAX = -0.3;
export const TONE_POSITIVE_MIN = 0.3;

/** Tone palette: rose, indigo, seafoam, and a neutral grey for unscored text. */
export const TONE_COLORS = Object.freeze({
  negative: '#ff5c8a',
  neutral: '#8b8cf8',
  positive: '#4fd1a5',
  unknown: '#b8c4d0',
});

export const POINT_PIXEL_SIZE = 8;
export const SELECTED_PIXEL_SIZE = 12;
export const MAX_PLACE_PIXEL_SIZE = 22;

export const HEADLINE_LABEL_CHARS = 48;

/** Headlines within ~100 m share one pin; keys round to this many decimals. */
export const PLACE_KEY_DECIMALS = 3;

/**
 * Cap on how far the camera's look-at ground point may be pulled from nadir
 * when deriving the centre of a "news in view" circle, in kilometres.
 *
 * Matches the provider's own 100 km radius cap (NEWS_REGION_MAX_RADIUS_KM):
 * a hit farther from nadir than the widest circle we could ever fetch is the
 * camera grazing the horizon, not something the operator is looking AT.
 */
export const REGION_LOOKAT_PULL_KM = 100;

/**
 * Fallback retention window for headline batches held in the browser, in
 * milliseconds. The proxy sends the real one as `retentionMs`; this is what
 * the layer assumes if a payload ever arrives without it.
 *
 * The map accumulates batches, so it needs the same one-hour cap the provider's
 * terms place on caching and the proxy already enforces — a pin that outlived
 * that window would be the browser holding provider data longer than the
 * server is allowed to.
 */
export const DEFAULT_RETENTION_MS = 60 * 60_000;

/**
 * Shortest headline, in words, that may be collapsed as a syndicated copy.
 * Syndicated wire and network stories carry long, distinctive headlines; a
 * short generic one ("Live updates", "Weather forecast") repeated at a place is
 * more likely two different stories that happen to share a title.
 */
export const MIN_SYNDICATED_HEADLINE_WORDS = 4;
