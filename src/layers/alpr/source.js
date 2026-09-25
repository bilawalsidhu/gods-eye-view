import { tilesForBounds } from '../../data/tomtomTiles.js';
import {
  MAX_VIEWPORT_DEGREES,
  QUERY_SNAP_DEGREES,
  QUERY_LIMIT,
} from './policy.js';
import {
  createVectorTileSource,
  validTileBounds,
} from '../../sources/vectorTiles.js';
import { decodeAlprTile } from './tileRecords.js';

/** Construct the viewport-bounded OpenStreetMap hourly extract adapter. */
export function createAlprTileSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const sources = ['us', 'ca'].map((country) =>
    createVectorTileSource({
      tileJsonUrl: `https://tiles.dontgetflocked.com/cameras-${country}-hourly.json`,
      allowedOrigin: 'https://tiles.dontgetflocked.com',
      decode: decodeAlprTile,
      fetchImpl,
      maxTiles: 16,
      ttlMs: 60 * 60 * 1000,
    }),
  );
  return {
    async fetch(box, signal) {
      if (
        !validTileBounds(box) ||
        box.north - box.south >
          MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9 ||
        box.east - box.west >
          MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9
      )
        throw new TypeError('ALPR requires a bounded city viewport');
      signal?.throwIfAborted();
      // Fast geographic rejection; the exact extract extents below refine coverage.
      if (box.east < -180 || box.west > -50 || box.north < 17 || box.south > 84)
        return {
          records: [],
          stale: false,
          saturated: false,
          noCoverage: true,
        };
      if (tilesForBounds(box, 11, { maxTiles: 17 }).length > 16)
        return { records: [], stale: false, saturated: false, zoomIn: true };
      const records = new Map();
      let covered = false,
        partial = false;
      for (const [index, source] of sources.entries()) {
        if (
          index === 1 &&
          (box.north < 41 ||
            box.south > 84 ||
            box.east < -142 ||
            box.west > -52)
        )
          continue;
        const metadata = await source.getMetadata(signal);
        const [west, south, east, north] = metadata.bounds || [];
        if (![west, south, east, north].every(Number.isFinite))
          throw new Error('Camera coverage unavailable');
        if (
          box.east < west ||
          box.west > east ||
          box.north < south ||
          box.south > north
        )
          continue;
        covered = true;
        const result = await source.fetchBounds(box, { zoom: 11, signal });
        partial ||= result.partial;
        for (const record of result.tiles.flat()) {
          if (
            record.latitude >= box.south &&
            record.latitude <= box.north &&
            record.longitude >= box.west &&
            record.longitude <= box.east
          )
            records.set(record.id, record);
        }
      }
      signal?.throwIfAborted();
      return {
        records: [...records.values()].slice(0, QUERY_LIMIT),
        stale: false,
        saturated: partial || records.size > QUERY_LIMIT,
        noCoverage: !covered,
      };
    },
    destroy() {
      for (const source of sources) source.clear();
    },
    label: 'OpenStreetMap · community mapped',
    attribution: {
      name: 'OpenStreetMap',
      description: '© OpenStreetMap contributors, ODbL',
      text: '© OpenStreetMap contributors, ODbL',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}

/** Compatibility factory name; now reads the OpenStreetMap tile extract. */
export const createOverpassAlprSource = createAlprTileSource;
export { buildOverpassQuery } from './records.js';
