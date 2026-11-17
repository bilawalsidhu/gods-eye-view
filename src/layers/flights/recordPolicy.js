export const GROUND_FLOOR_CLAMP_RADIUS_KM = 150;

export const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;

/** Maximum feed fixes retained for drawing: enough to reach back over the
 *  longest display delay at one report per poll. */
export const POSITION_HISTORY_LIMIT = 24;

export const LANDED_MISSING_POLL_LIMIT = 1;

export const MISSING_POLL_LIMIT = 3;

/** The tracked contact is kept this long after its newest fix: five minutes
 *  coasting, then five stopped as SIGNAL LOST. */
export const TRACKED_RETENTION_MS = 10 * 60_000;

/** Cooldown in milliseconds after a transient source error. */
export const ERROR_BACKOFF_INTERVAL = 20000;

/** Local equirectangular distance used for viewer-proximate floor sampling. */
export { approxDistanceKm } from '../../data/approxDistance.js';
