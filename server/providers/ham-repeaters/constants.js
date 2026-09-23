export const HAM_REPEATERS_MOUNT_PATH = '/api/ham-repeaters';
export const HAM_REPEATERS_NEARBY_PATH = '/nearby';
export const HAMRIG_DEFAULT_BASE_URL = 'https://hamrig.com';
export const HAMRIG_FM_PATH = '/api/fm/repeaters/nearby';
export const HAMRIG_DSTAR_PATH = '/api/dstar/repeaters/nearby';
export const HAM_REPEATERS_CACHE_MS = 10 * 60 * 1000;
/** A cached answer may be served this many TTLs after an upstream failure. */
export const HAM_REPEATERS_STALE_FACTOR = 10;
export const HAM_REPEATERS_CACHE_MAX_ENTRIES = 256;
export const HAM_REPEATERS_TIMEOUT_MS = 20_000;
export const HAM_REPEATERS_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const HAM_REPEATERS_USER_AGENT =
  'GodsEyeView/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';
/** Search bounds the browser route accepts; the upstream caps radius at 500 km. */
export const SEARCH_MIN_RADIUS_KM = 1;
export const SEARCH_MAX_RADIUS_KM = 500;
export const SEARCH_DEFAULT_RADIUS_KM = 100;
export const SEARCH_MAX_LIMIT = 200;
export const SEARCH_DEFAULT_LIMIT = 200;
/** HamRig's D-STAR route caps `limit` at 100. */
export const HAMRIG_DSTAR_MAX_LIMIT = 100;
export const SEARCH_KINDS = Object.freeze(['all', 'fm', 'dstar']);
