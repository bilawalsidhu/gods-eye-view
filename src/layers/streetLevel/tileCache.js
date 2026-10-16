/** Decoded coverage tiles kept, and for how long. */
export const TILE_CACHE_SIZE = 24;
export const TILE_CACHE_TTL_MS = 10 * 60_000;

/** Least-recently-used map: reading an entry renews it. */
export function createLru(limit) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

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
