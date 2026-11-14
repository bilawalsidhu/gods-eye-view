/** Bounded transport concurrency; preserve input order for deterministic validation. */
export async function readTiles(tiles, read) {
  const results = new Array(tiles.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(4, tiles.length) }, async () => {
      while (!failed && next < tiles.length) {
        const i = next++;
        try {
          results[i] = await read(tiles[i]);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  return results;
}
