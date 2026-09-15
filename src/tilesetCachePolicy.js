/**
 * Photoreal tile-cache budget policy (Phase 9 Batch P — docs/PLAN.md).
 *
 * `createGooglePhotorealistic3DTileset` requests a 1536 MB tile cache with a
 * 1024 MB overflow allowance — a 2.5 GB ceiling for tiles-resident GPU/CPU
 * memory. Measured residency at boot (Austin fly-in settled) is ~220 MB
 * (probe: `totalMemoryUsageInBytes`), so the ceiling only binds under dense
 * city traversal — exactly where it lets VRAM spike hardest on the GPUs the
 * operator flagged. 384 MB cache + 128 MB overflow (3:1, one quarter of the
 * stock ceiling) keeps a full downtown fly-through resident while bounding
 * the worst case; Cesium trims to lower LODs beyond it, which reads as
 * ordinary tile refinement under motion.
 *
 * Escape hatches (same pattern as `?msaa=` / `?overlayDpr=`):
 *   `?tileCacheMB=N` — cache size in MiB (1..4096); overflow follows at 1/3.
 *   `?tileCacheOverflowMB=N` — explicit overflow override.
 *
 * Assignment post-construction is supported: `cacheBytes` and
 * `maximumCacheOverflowBytes` are plain public properties read by the
 * tileset's cache trim each update (verified live by the Batch P probe,
 * which asserts the booted tileset reports the policy values).
 */

export const DEFAULT_TILESET_CACHE_MB = 384;
export const DEFAULT_TILESET_OVERFLOW_MB = 128;
/** Hard ceiling for overrides — a typo'd `?tileCacheMB=999999` must not
 *  resurrect the 2.5 GB problem it exists to prevent. */
export const MAX_TILESET_CACHE_MB = 4096;

const MIB = 1024 * 1024;

function clampCacheMiB(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TILESET_CACHE_MB;
  return Math.min(MAX_TILESET_CACHE_MB, n);
}

/**
 * Resolve the tile-cache budget from query overrides.
 * @param {object} [options]
 * @param {string} [options.search] Query string (defaults to the live
 *   location, injectable for tests).
 * @returns {{cacheBytes: number, maximumCacheOverflowBytes: number,
 *   cacheMiB: number, overflowMiB: number}} Spread-ready for a tileset.
 */
export function resolveTilesetCacheOptions({
  search = globalThis.location?.search ?? '',
} = {}) {
  const params = new URLSearchParams(search);
  const rawCache = params.get('tileCacheMB');
  const rawOverflow = params.get('tileCacheOverflowMB');

  const cacheMiB = clampCacheMiB(rawCache !== null ? rawCache : DEFAULT_TILESET_CACHE_MB);
  const overflowMiB = rawOverflow !== null
    ? clampCacheMiB(rawOverflow)
    // Preserve the stock 3:1 cache:overflow ratio when only the cache is set.
    : Math.max(1, Math.round(cacheMiB / 3));

  return {
    cacheBytes: cacheMiB * MIB,
    maximumCacheOverflowBytes: overflowMiB * MIB,
    cacheMiB,
    overflowMiB,
  };
}

/**
 * Apply the cache policy to a live tileset. Safe on null (the fallback-globe
 * boot path has no tileset); returns the policy actually applied so callers
 * can log it.
 * @param {object|null} tileset A Cesium3DTileset (duck-typed: just needs the
 *   two writable properties).
 * @param {object} [policy] Pre-resolved policy (defaults to live resolution).
 * @returns {object|null} The applied policy, or null when there is no tileset.
 */
export function applyTilesetCachePolicy(tileset, policy = resolveTilesetCacheOptions()) {
  if (!tileset) return null;
  tileset.cacheBytes = policy.cacheBytes;
  tileset.maximumCacheOverflowBytes = policy.maximumCacheOverflowBytes;
  return policy;
}
