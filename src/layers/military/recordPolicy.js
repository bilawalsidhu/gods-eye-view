export const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;

export const POSITION_HISTORY_LIMIT = 5;

export const LANDED_MISSING_POLL_LIMIT = 1;

export const MISSING_POLL_LIMIT = 3;

/** The tracked contact is kept this long after its newest fix: five minutes
 *  coasting, then five stopped as SIGNAL LOST. */
export const TRACKED_RETENTION_MS = 10 * 60_000;

export const ERROR_BACKOFF_INTERVAL = 20000;
