// src/data/tleCache.js
/**
 * Browser cache for CelesTrak TLE group text, riding `localCache.js`.
 *
 * CelesTrak is a free community service that explicitly asks consumers not to
 * re-fetch a group more than a couple of times a day. The server proxy already
 * holds groups for 6 h per isolate; this tier makes a REPEAT SESSION cost the
 * upstream nothing at all (a static deploy's isolate dies constantly, so the
 * server tier alone restarts cold). 6 h matches the proxy TTL — TLE
 * predictions degrade over days, so longer browser caching would trade
 * accuracy for load, and the layer exists to be accurate.
 *
 * Large catalogs (the dense `active` file is megabytes of text) are refused:
 * they would churn the localStorage quota for one entry. They stay server- or
 * network-served; the core catalogs this layer boots with are the target.
 *
 * @module data/tleCache
 */

import { readLocalCache, writeLocalCache } from './localCache.js';

/** Same window as the /api/celestrak proxy's per-isolate TTL. */
const TLE_TTL_MS = 6 * 60 * 60 * 1000;
/** Refuse to persist catalogs above this size — quota is shared, not ours. */
const TLE_CACHE_MAX_CHARS = 128_000;

/**
 * Read a cached TLE group.
 * @param {string} group CelesTrak group name (the proxy path segment).
 * @returns {string|null} The cached text, or null on miss/expiry.
 */
export function readCachedTle(group) {
  if (!group) return null;
  const cached = readLocalCache(`tle:${group}`);
  return cached.hit && typeof cached.value === 'string' ? cached.value : null;
}

/**
 * Persist a TLE group. Oversized catalogs and storage failures are silent
 * no-ops — the network path still served the caller.
 * @param {string} group
 * @param {string} text
 * @returns {boolean} True when persisted.
 */
export function writeCachedTle(group, text) {
  if (!group || typeof text !== 'string' || text.length > TLE_CACHE_MAX_CHARS) return false;
  return writeLocalCache(`tle:${group}`, text, { ttlMs: TLE_TTL_MS });
}
