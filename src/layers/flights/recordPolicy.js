export const GROUND_FLOOR_CLAMP_RADIUS_KM = 150;

export const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;

/** Maximum feed fixes retained for dead reckoning. */
export const POSITION_HISTORY_LIMIT = 5;

export const LANDED_MISSING_POLL_LIMIT = 1;

export const MISSING_POLL_LIMIT = 3;

/** Cooldown in milliseconds after a transient source error. */
export const ERROR_BACKOFF_INTERVAL = 20000;

/** Local equirectangular distance used for viewer-proximate floor sampling. */
export { approxDistanceKm } from '../../data/approxDistance.js';
