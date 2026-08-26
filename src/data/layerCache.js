/**
 * localStorage caching utilities for God's Eye View data layers.
 * Provides TTL-based caching with automatic expiration.
 */

const PREFIX = 'gev_cache_v2';

/**
 * Read cached data if it exists and is not expired.
 * @param {string} key - Cache key (without prefix)
 * @param {number} [maxAgeMs=60000] - Max age in ms (default 60s)
 * @returns {any|null} Cached data or null if missing/expired
 */
export function getCached(key, maxAgeMs = 60_000) {
  try {
    const raw = localStorage.getItem(`${PREFIX}:${key}`);
    if (!raw) return null;
    const { data, timestamp, ttl } = JSON.parse(raw);
    const effectiveTtl = ttl ?? maxAgeMs;
    if (Date.now() - timestamp > effectiveTtl) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Write data to localStorage cache.
 * @param {string} key - Cache key (without prefix)
 * @param {any} data - Data to cache (must be JSON-serializable)
 * @param {number} [ttlMs=60000] - TTL in ms (default 60s)
 */
export function setCached(key, data, ttlMs = 60_000) {
  try {
    localStorage.setItem(`${PREFIX}:${key}`, JSON.stringify({
      data,
      timestamp: Date.now(),
      ttl: ttlMs,
    }));
  } catch {
    // localStorage unavailable (private mode, quota exceeded)
  }
}

/**
 * Clear all layer cache entries.
 */
export function clearCache() {
  try {
    const prefix = `${PREFIX}:`;
    Object.keys(localStorage)
      .filter(k => k.startsWith(prefix))
      .forEach(k => localStorage.removeItem(k));
  } catch {
    // localStorage unavailable
  }
}

/** Cache key constants */
export const CACHE_KEYS = {
  AIS_VESSELS:    'ais_vessels',
  FLIGHT_META:    'flight_meta',
  DETECTION:      'detection',
  VIEW_STATE:     'view_state',
  SCOPE_SETTINGS: 'scope_settings',
};
