import { createVectorTileSource } from '../../sources/vectorTiles.js';
import { clipTileLine } from '../../sources/openFreeMap.js';
import { tileToBBox } from '../../data/tomtomTiles.js';
import { decodeFlowTile } from './flowDecode.js';

/** Own one bounded decoded flow cache; every request still passes the server tile budget. */
export function createFlowTileSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const tiles = createVectorTileSource({
    template: '/api/tomtom/flow/{z}/{x}/{y}.pbf',
    allowedOrigin: 'http://localhost',
    decode: (bytes, z, x, y) =>
      decodeFlowTile(bytes, z, x, y, { strict: true }).flatMap((segment) =>
        clipTileLine(segment.coords, tileToBBox(z, x, y)).map((coords) => ({
          ...segment,
          coords,
        })),
      ),
    fetchImpl,
    ttlMs: 120_000,
    maxTiles: 16,
  });
  let partial = false;
  return {
    async fetchFlowForBounds(bounds, { signal, zoom = 12 } = {}) {
      const result = await tiles.fetchBounds(bounds, { zoom, signal });
      partial = result.partial;
      return result.tiles.flat().flatMap((segment) =>
        clipTileLine(segment.coords, bounds).map((coords) => ({
          ...segment,
          coords,
        })),
      );
    },
    getFlowSessionStats: () => ({ ...tiles.getStats(), partial }),
    resetFlowTileCache: () => tiles.clear(),
  };
}
