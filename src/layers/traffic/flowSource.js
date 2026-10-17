import { isDrivableFlowSegment } from './roadModes.js';
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
      decodeFlowTile(bytes, z, x, y, { strict: true })
        .filter(isDrivableFlowSegment)
        .flatMap((segment) =>
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
  /**
   * Flow segments for bounds, with whether any covering tile failed to load
   * for this request.
   */
  async function fetchFlowDetail(bounds, { signal, zoom = 12 } = {}) {
    const result = await tiles.fetchBounds(bounds, {
      zoom,
      signal,
      tiles: bounds.coverage?.coarse,
    });
    partial = result.partial;
    const segments = bounds.coverage
      ? result.tiles.flat()
      : result.tiles.flat().flatMap((segment) =>
          clipTileLine(segment.coords, bounds).map((coords) => ({
            ...segment,
            coords,
          })),
        );
    return { segments, partial: result.partial === true };
  }
  return {
    fetchFlowDetail,
    async fetchFlowForBounds(bounds, options) {
      return (await fetchFlowDetail(bounds, options)).segments;
    },
    getFlowSessionStats: () => ({ ...tiles.getStats(), partial }),
    resetFlowTileCache: () => tiles.clear(),
  };
}
