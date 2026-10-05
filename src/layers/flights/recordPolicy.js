export const GROUND_FLOOR_CLAMP_RADIUS_KM = 150;

export const GROUND_FLOOR_WARM_MAX_ALT_M = 4500;

/** Maximum feed fixes retained for dead reckoning. */
export const POSITION_HISTORY_LIMIT = 5;

export const LANDED_MISSING_POLL_LIMIT = 1;

export const MISSING_POLL_LIMIT = 3;

/** Cooldown in milliseconds after a transient source error. */
export const ERROR_BACKOFF_INTERVAL = 20000;

/** Local equirectangular distance used for viewer-proximate floor sampling. */
export function approxDistanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * 111.32;
  const dLon =
    (lon2 - lon1) * 111.32 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}
