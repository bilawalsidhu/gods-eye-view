import { WQ_MAX_CACHE_ENTRIES, WQ_MEMORY_TTL_MS } from './constants.js';

/**
 * In-memory response cache. Deliberately memory-only for now: unlike the
 * Overpass-backed caches there is no disk tier yet, so a restart re-fetches.
 * The long TTL above makes that acceptable; add a disk tier only with a
 * matching eviction test.
 */
export const _waterQualityCache = new Map();

/** Evict oldest entries past the ceiling so a long session cannot grow without bound. */
export function trimWaterQualityCache(cache = _waterQualityCache) {
  while (cache.size > WQ_MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Choose where this request is answered from, without performing it.
 *
 * Kept pure over its inputs so the tier decision is testable without a server:
 * a fresh memory entry answers directly, an in-flight request is shared, and
 * everything else goes upstream.
 * @param {{cacheKey:string, memoryCache:Map, inFlight:Map, now:number, ttlMs:number}} options Lookup inputs.
 * @returns {{source:'MEMORY'|'INFLIGHT'|'UPSTREAM', entry?:object}} Resolved tier.
 */
export function resolveWaterQualityTier({
  cacheKey,
  memoryCache = _waterQualityCache,
  inFlight,
  now = Date.now(),
  ttlMs = WQ_MEMORY_TTL_MS,
}) {
  const cached = memoryCache.get(cacheKey);
  if (cached && now - cached.cachedAt <= ttlMs)
    return { source: 'MEMORY', entry: cached };
  if (inFlight?.has(cacheKey)) return { source: 'INFLIGHT' };
  return { source: 'UPSTREAM' };
}
