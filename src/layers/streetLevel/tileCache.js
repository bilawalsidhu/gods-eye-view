import { createLru } from '../../data/lru.js';

/** Decoded coverage tiles kept, and for how long. */
const TILE_CACHE_SIZE = 24;
const TILE_CACHE_TTL_MS = 10 * 60_000;

/**
 * Loaded (decoded) coverage tiles by `keyOf` (default `z/x/y`), at most `size`, each for
 * `ttlMs`: a pan back, or a zoom across bands and back, neither fetches nor
 * decodes them again. A load that fails is not kept.
 */
export function createTileCache({
  load,
  size = TILE_CACHE_SIZE,
  ttlMs = TILE_CACHE_TTL_MS,
  now = Date.now,
  keyOf = (tile) => `${tile.z}/${tile.x}/${tile.y}`,
}) {
  const kept = createLru(size);
  return {
    async get(tile, options) {
      const key = keyOf(tile);
      const entry = kept.get(key);
      if (entry && now() - entry.at < ttlMs) return entry.tile;
      const loaded = await load(tile, options);
      kept.set(key, { at: now(), tile: loaded });
      return loaded;
    },
    /** Forget every tile (the layer is off: its memory goes back). */
    clear: () => kept.clear(),
  };
}
