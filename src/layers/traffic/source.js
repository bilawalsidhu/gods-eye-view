import { createFlowTileSource } from './flowSource.js';
import { tilesForBounds } from '../../data/tomtomTiles.js';
import { clipTileLine } from '../../sources/openFreeMap.js';
import { createOpenFreeMapSource } from '../../sources/openFreeMap.js';
import { validTileBounds } from '../../sources/vectorTiles.js';
export { normalizeOverpassRoads } from '../../sources/overpassRoads.js';

/** Shrink only the detail footprint, centered on the look-at fetch box, to fit 16 tiles. */
export function trafficDetailBounds(box) {
  const center = {
    lat: (box.north + box.south) / 2,
    lon: (box.east + box.west) / 2,
  };
  let detail = { ...box };
  while (tilesForBounds(detail, 14, { maxTiles: 17 }).length > 16) {
    detail = {
      south: center.lat + (detail.south - center.lat) * 0.9,
      north: center.lat + (detail.north - center.lat) * 0.9,
      west: center.lon + (detail.west - center.lon) * 0.9,
      east: center.lon + (detail.east - center.lon) * 0.9,
    };
  }
  return detail;
}

/** A classified road failure with a display-safe reason and machine-readable status. */
export class RoadRequestError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message, { cause });
    this.name = 'RoadRequestError';
    this.status = status;
  }
}

/** Name the road upstream without exposing raw transport errors or missing codes. */
export function roadRequestError(status, cause) {
  const code = Number.isFinite(status) ? status : null;
  const message =
    code === 429
      ? 'OpenFreeMap tiles rate-limited'
      : code === 504 || cause?.name === 'TimeoutError'
        ? 'OpenFreeMap tiles timed out'
        : code === null
          ? 'OpenFreeMap tiles unavailable'
          : `OpenFreeMap tiles unavailable (HTTP ${code})`;
  return Object.assign(new RoadRequestError(message, { status: code, cause }), {
    retryable: cause?.retryable !== false,
    code: cause?.code,
  });
}

/** Supply tile-derived road geometry and flow availability without Overpass queries. */
export function createTrafficSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  mapTiles = createOpenFreeMapSource({ fetchImpl }),
} = {}) {
  const flow = createFlowTileSource({ fetchImpl });
  return {
    ...flow,
    resetFlowTileCache() {
      flow.resetFlowTileCache();
      mapTiles.clear();
    },
    async requestRoads(box, { majorOnly = false, signal } = {}) {
      if (
        !validTileBounds(box) ||
        box.north - box.south > 10 ||
        box.east - box.west > 10
      )
        throw new TypeError('A bounded road viewport is required');
      const area = majorOnly ? box : trafficDetailBounds(box);
      let result;
      try {
        result = await mapTiles.fetchBounds(area, {
          zoom: majorOnly ? 12 : 14,
          signal,
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.name === 'AbortError') throw error;
        throw roadRequestError(error?.status, error);
      }
      const data = {
        roads: result.tiles
          .flatMap((tile) => tile.roads)
          .flatMap((road) =>
            clipTileLine(road.coordinates, area).map((coordinates) => ({
              ...road,
              coordinates,
            })),
          ),
        roadSource: 'OpenStreetMap',
        partial: result.partial,
        detailLimited:
          !majorOnly && (area.north !== box.north || area.east !== box.east),
        detailBounds: majorOnly ? null : area,
      };
      signal?.throwIfAborted();
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async json() {
          return data;
        },
      };
    },
    async getStatus({ signal } = {}) {
      const timeout = AbortSignal.timeout(8000);
      const response = await fetchImpl('/api/tomtom/status', {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok)
        throw Object.assign(new Error('TomTom status unavailable'), {
          status: Number.isFinite(response.status) ? response.status : null,
        });
      const status = await response.json();
      signal?.throwIfAborted();
      if (typeof status?.hasKey !== 'boolean')
        throw new Error('Malformed traffic status');
      return status;
    },
  };
}
