export const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;

export const POSITION_HISTORY_LIMIT = 5;

export const LANDED_MISSING_POLL_LIMIT = 1;

export const MISSING_POLL_LIMIT = 3;

export const ERROR_BACKOFF_INTERVAL = 20000;

/**
 * Scene radius (nautical miles) the military snapshot request is filtered to
 * server-side (GET /api/adsblol/mil?lat=&lon=&radiusNm=) — only while the
 * camera is below MILITARY_REGIONAL_VIEW_MAX_HEIGHT_M; the globe view keeps
 * the worldwide list.
 */
export const MILITARY_SCENE_RADIUS_NM = 600;

/** Camera height (m) below which the view counts as regional (2,000 km). */
export const MILITARY_REGIONAL_VIEW_MAX_HEIGHT_M = 2_000_000;
