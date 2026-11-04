import { tilesForBounds, tileToBBox } from '../../data/tomtomTiles.js';
import {
  OVERPASS_URL,
  QUERY_LIMIT,
  MAX_VIEWPORT_DEGREES,
  QUERY_SNAP_DEGREES,
  DETAIL_MIN_ZOOM,
  DETAIL_MAX_ZOOM,
  DETAIL_MAX_TILES,
  SOURCE_RECORD_LIMIT,
  PRECISION_CACHE_LIMIT,
} from './policy.js';
import {
  createVectorTileSource,
  validTileBounds,
} from '../../sources/vectorTiles.js';
import {
  buildOverpassQuery,
  normalizeAlprNode,
  validateAlprSnapshot,
} from './records.js';
import { decodeAlprTile } from './tileRecords.js';
// Marks text for i18n extraction; the UI translates it with t(). Kept local
// because AI tool services import this module outside the browser.
const msg = (text) => text;

export const DEFLOCK_TILE_ORIGIN = 'https://deflock.dontgetflocked.com';
const EXISTING_TILE_ORIGIN = 'https://tiles.dontgetflocked.com';

function validAlprBox(box) {
  return (
    validTileBounds(box) &&
    box.north - box.south <=
      MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9 &&
    box.east - box.west <= MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9
  );
}

function nearestRecords(records, box) {
  if (records.length <= SOURCE_RECORD_LIMIT) return records;
  const lat = (box.south + box.north) / 2;
  const lon = (box.west + box.east) / 2;
  const scale = Math.cos((lat * Math.PI) / 180);
  return records
    .map((record) => ({
      record,
      distance:
        (record.latitude - lat) ** 2 + ((record.longitude - lon) * scale) ** 2,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, SOURCE_RECORD_LIMIT)
    .map(({ record }) => record);
}

/**
 * Finest attributed extract zoom whose tiles for `box` fit the per-view cap,
 * or null when even z9 would not (the layer asks the user to zoom in).
 * @param {{south:number, west:number, north:number, east:number}} box View box.
 * @returns {number|null} Tile zoom.
 */
export function alprDetailZoom(box) {
  for (let zoom = DETAIL_MAX_ZOOM; zoom >= DETAIL_MIN_ZOOM; zoom--)
    if (
      tilesForBounds(box, zoom, { maxTiles: DETAIL_MAX_TILES + 1 }).length <=
      DETAIL_MAX_TILES
    )
      return zoom;
  return null;
}

/**
 * Tile coordinates are quantized per zoom (about 19 m at z9, 2 m at z12).
 * Remember each camera's finest position so zooming out never nudges a marker
 * that a closer view already placed precisely. Bounded, oldest first.
 * @param {number} [limit] Cameras remembered.
 * @returns {{apply: (record: object, zoom: number) => object, clear: () => void,
 *   size: () => number}} Cache.
 */
export function createAlprPrecisionCache(limit = PRECISION_CACHE_LIMIT) {
  const known = new Map();
  return {
    apply(record, zoom) {
      const finer = known.get(record.id);
      if (finer && finer.zoom > zoom)
        return finer.latitude === record.latitude &&
          finer.longitude === record.longitude
          ? record
          : { ...record, latitude: finer.latitude, longitude: finer.longitude };
      known.delete(record.id);
      known.set(record.id, {
        zoom,
        latitude: record.latitude,
        longitude: record.longitude,
      });
      while (known.size > limit) known.delete(known.keys().next().value);
      return record;
    },
    clear: () => known.clear(),
    size: () => known.size,
  };
}

/** Construct the viewport-bounded OpenStreetMap hourly extract adapter. */
export function createAlprTileSource({
  tileFetchImpl = (...args) => globalThis.fetch(...args),
  tileOrigin = EXISTING_TILE_ORIGIN,
  metadataMaxAgeMs = Infinity,
  now = () => Date.now(),
} = {}) {
  const sources = ['us', 'ca'].map((country) =>
    createVectorTileSource({
      tileJsonUrl: `${tileOrigin}/cameras-${country}-hourly.json`,
      allowedOrigin: tileOrigin,
      decode: decodeAlprTile,
      fetchImpl: tileFetchImpl,
      maxTiles: DETAIL_MAX_TILES,
      ttlMs: 60 * 60 * 1000,
      now,
    }),
  );
  const precision = createAlprPrecisionCache();
  const precise = precision.apply;
  let metadataReadAt = now();
  return {
    /**
     * Read the camera records for every extract tile covering `box`.
     * @param {{south:number, west:number, north:number, east:number}} box View box.
     * @param {AbortSignal} [signal] Cancellation.
     * @returns {Promise<{records: Array<object>, stale: boolean, saturated: boolean,
     *   noCoverage?: boolean, zoomIn?: boolean, coverage?: object, zoom?: number}>}
     *   Records inside the fetched tiles; `coverage` is those tiles' bounds.
     */
    async fetch(box, signal) {
      if (!validAlprBox(box))
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
      const zoom = alprDetailZoom(box);
      if (zoom === null)
        return { records: [], stale: false, saturated: false, zoomIn: true };
      // DeFlock's primary publishes build-pinned tile URLs. Refresh the alias
      // instead of keeping the first hourly build for the whole page session.
      if (now() - metadataReadAt >= metadataMaxAgeMs) {
        for (const source of sources) source.clear();
        metadataReadAt = now();
      }
      const tiles = tilesForBounds(box, zoom, {
        maxTiles: DETAIL_MAX_TILES + 1,
      });
      const tileBounds = tiles.map((tile) => tileToBBox(zoom, tile.x, tile.y));
      const coverage = {
        south: Math.min(...tileBounds.map((b) => b.south)),
        west: Math.min(...tileBounds.map((b) => b.west)),
        north: Math.max(...tileBounds.map((b) => b.north)),
        east: Math.max(...tileBounds.map((b) => b.east)),
      };
      const records = new Map();
      let covered = false,
        partial = false;
      const failures = [];
      for (const [index, source] of sources.entries()) {
        if (
          index === 1 &&
          (box.north < 41 ||
            box.south > 84 ||
            box.east < -142 ||
            box.west > -52)
        )
          continue;
        try {
          const metadata = await source.getMetadata(signal);
          const [west, south, east, north] = metadata.bounds || [];
          if (![west, south, east, north].every(Number.isFinite))
            throw new Error(msg('Camera coverage unavailable'));
          if (
            box.east < west ||
            box.west > east ||
            box.north < south ||
            box.south > north
          )
            continue;
          covered = true;
          const result = await source.fetchBounds(box, { zoom, signal });
          partial ||= result.partial;
          for (const record of result.tiles.flat())
            records.set(record.id, precise(record, zoom));
        } catch (error) {
          signal?.throwIfAborted();
          if (error?.name === 'AbortError') throw error;
          failures.push(error);
        }
      }
      signal?.throwIfAborted();
      // US/Canada extract bounds overlap. A missing US tile must not prevent
      // Canadian locations from loading, but a failed read is never a zero.
      if (failures.length && !records.size) throw failures[0];
      partial ||= failures.length > 0;
      const list = [...records.values()];
      const truncated = list.length > SOURCE_RECORD_LIMIT;
      return {
        records: nearestRecords(list, box),
        stale: false,
        saturated: partial || truncated,
        noCoverage: !covered,
        // A partial or truncated read does not cover its tiles; reuse only the box.
        coverage: partial || truncated ? { ...box } : coverage,
        zoom,
      };
    },
    detailZoom: alprDetailZoom,
    destroy() {
      for (const source of sources) source.clear();
      precision.clear();
    },
    label: msg('OpenStreetMap · community mapped'),
    attribution: {
      name: 'OpenStreetMap',
      description: '© OpenStreetMap contributors, ODbL',
      text: '© OpenStreetMap contributors, ODbL',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}

/** DeFlock's current public US/Canada tiles, with hourly build refresh. */
export function createDeflockAlprSource(options = {}) {
  return createAlprTileSource({
    ...options,
    tileOrigin: DEFLOCK_TILE_ORIGIN,
    metadataMaxAgeMs: 60 * 60 * 1000,
  });
}

/** Merge DeFlock with the existing feed by OSM identity, retaining a healthy
 * feed if its peer is unavailable. No camera requests start until fetch(). */
export function createCombinedAlprSource({
  sources = [createDeflockAlprSource(), createAlprTileSource()],
} = {}) {
  if (
    !Array.isArray(sources) ||
    !sources.length ||
    sources.some((s) => typeof s?.fetch !== 'function')
  )
    throw new TypeError('ALPR requires camera sources with fetch methods');
  return {
    async fetch(box, signal) {
      if (!validAlprBox(box))
        throw new TypeError('ALPR requires a bounded city viewport');
      signal?.throwIfAborted();
      const results = await Promise.allSettled(
        sources.map((source) =>
          Promise.resolve()
            .then(() => source.fetch(box, signal))
            .then(validateAlprSnapshot),
        ),
      );
      signal?.throwIfAborted();
      const good = results
        .filter((r) => r.status === 'fulfilled')
        .map((r) => r.value);
      const failed = results.filter((r) => r.status === 'rejected');
      if (
        !good.length ||
        (failed.length && good.every((r) => r.noCoverage || r.zoomIn))
      )
        throw (
          failed[0]?.reason ?? new Error(msg('Camera coverage unavailable'))
        );
      const records = new Map();
      for (const snapshot of good) {
        for (const record of snapshot.records) {
          const previous = records.get(record.id);
          const at = Date.parse(record.osmTimestamp);
          const previousAt = Date.parse(previous?.osmTimestamp);
          // Prefer a newer OSM edit when both publishers supply one. Ties
          // and missing timestamps retain DeFlock's record (first source).
          if (
            !previous ||
            (Number.isFinite(at) &&
              Number.isFinite(previousAt) &&
              at > previousAt)
          )
            records.set(record.id, record);
        }
      }
      const all = [...records.values()];
      const truncated = all.length > SOURCE_RECORD_LIMIT;
      const saturated = truncated || good.some((r) => r.saturated);
      const boxes = good.map((r) => r.coverage || box);
      const coverage =
        failed.length || saturated
          ? { ...box }
          : {
              south: Math.max(...boxes.map((b) => b.south)),
              west: Math.max(...boxes.map((b) => b.west)),
              north: Math.min(...boxes.map((b) => b.north)),
              east: Math.min(...boxes.map((b) => b.east)),
            };
      const zooms = good.map((r) => r.zoom).filter(Number.isFinite);
      return {
        records: nearestRecords(all, box),
        stale: good.some((r) => r.stale),
        saturated,
        partialSources: failed.length > 0,
        noCoverage: good.every((r) => r.noCoverage),
        zoomIn: good.every((r) => r.zoomIn),
        coverage,
        zoom: zooms.length ? Math.min(...zooms) : undefined,
      };
    },
    detailZoom: alprDetailZoom,
    destroy() {
      for (const source of new Set(sources)) source.destroy?.();
    },
    label: msg('DeFlock + OpenStreetMap · community mapped'),
    attribution: {
      name: 'OpenStreetMap',
      description:
        '© OpenStreetMap contributors, ODbL; feeds via DeFlock/FlockHopper',
      text: '© OpenStreetMap contributors, ODbL · DeFlock/FlockHopper',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}

/** Construct the bounded OSM request adapter without starting a request. */
export function createOverpassAlprSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  async function fetchAlprNodes(box, signal) {
    signal?.throwIfAborted();
    if (
      !box ||
      ![box.south, box.west, box.north, box.east].every(Number.isFinite) ||
      box.south < -90 ||
      box.north > 90 ||
      box.west < -180 ||
      box.east > 180 ||
      box.north <= box.south ||
      box.east <= box.west ||
      box.north - box.south >
        MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9 ||
      box.east - box.west > MAX_VIEWPORT_DEGREES + 2 * QUERY_SNAP_DEGREES + 1e-9
    ) {
      throw new TypeError('ALPR requires a bounded city viewport');
    }
    const query = buildOverpassQuery(box.south, box.west, box.north, box.east);
    const response = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      const message =
        response.status === 429
          ? 'Overpass rate-limited'
          : response.status === 504
            ? 'Overpass timed out'
            : 'Overpass temporarily unavailable';
      throw new Error(message);
    }
    const stale = response.headers.get('x-overpass-cache') === 'STALE';
    const payload = await response.json();
    signal?.throwIfAborted();
    // The shared proxy already rejects query errors. Validate here too so a
    // malformed or partial response never becomes an authoritative empty map.
    if (!Array.isArray(payload?.elements) || payload.remark) {
      throw new Error(msg('Overpass returned an incomplete camera response'));
    }
    return {
      records: [
        ...new Map(
          payload.elements
            .slice(0, QUERY_LIMIT)
            .map(normalizeAlprNode)
            .filter(Boolean)
            .map((record) => [record.id, record]),
        ).values(),
      ],
      stale,
      saturated: payload.elements.length >= QUERY_LIMIT,
    };
  }
  return {
    fetch: fetchAlprNodes,
    label: msg('OpenStreetMap · community mapped'),
    attribution: {
      name: 'OpenStreetMap',
      description: 'OpenStreetMap contributors (ODbL 1.0; community mapped)',
      text: '© OpenStreetMap contributors',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}

export { buildOverpassQuery } from './records.js';
