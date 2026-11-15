import {
  createHybridFill,
  flowSegmentsToRoads,
  normalizeRoadMode,
  normalizeRoadModes,
  resolveRoadMode,
  roadModesSimulate,
  ROAD_SOURCE_LABELS,
} from './roadModes.js';
import { phaseTiming } from '../../sources/phaseTiming.js';
import { createFlowTileSource } from './flowSource.js';
import { tileToBBox, tilesForBounds } from '../../data/tomtomTiles.js';
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

/** Longitude/latitude extent of one line; NaN coordinates leave it unusable. */
function lineExtent(coordinates) {
  let west = Infinity,
    east = -Infinity,
    south = Infinity,
    north = -Infinity;
  for (const [lon, lat] of coordinates) {
    if (!(lon >= west)) west = lon;
    if (!(lon <= east)) east = lon;
    if (!(lat >= south)) south = lat;
    if (!(lat <= north)) north = lat;
  }
  return { coordinates, west, east, south, north, settled: false };
}

/**
 * What `clipTileLine` returns for a line lying wholly inside the clip region:
 * the same line with each vertex recomputed from the one before it. Returns
 * null for a line under the 12 m floor `clipTileLine` drops.
 */
function unclippedLine(coordinates) {
  if (coordinates.length < 2) return null;
  const out = [];
  let metres = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1],
      b = coordinates[i];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    if (i === 1) out.push([a[0] + 0 * dx, a[1] + 0 * dy]);
    out.push([a[0] + dx, a[1] + dy]);
    metres +=
      Math.hypot(
        (out[i][0] - out[i - 1][0]) * Math.cos((out[i][1] * Math.PI) / 180),
        out[i][1] - out[i - 1][1],
      ) * 111320;
  }
  return metres >= 12 ? out : null;
}

const sameLine = (a, b) =>
  a.every(
    (point, i) => Object.is(point[0], b[i][0]) && Object.is(point[1], b[i][1]),
  );

/**
 * Keep coarse roads only outside the detailed tile cores.
 *
 * Each tile splits a line into the four regions around its core. Nearly every
 * coarse road lies wholly inside one of those regions for nearly every tile,
 * where the clip hands the line back unchanged, so that case is answered from
 * the line's extent and only a line that reaches a tile's core or edge is
 * clipped. Clipping every road against every tile froze the page for hundreds
 * of milliseconds per road load at street level.
 *
 * `clip` is injectable for tests.
 */
export function outsideDetailTiles(roads, tiles, clip = clipTileLine) {
  const boxes = tiles.map((tile) => tileToBBox(tile.z, tile.x, tile.y));
  return roads.flatMap((road) => {
    let lines = [lineExtent(road.coordinates)];
    for (const box of boxes) {
      const next = [];
      for (const line of lines) {
        // Strictly inside one region, and inside the bounds every region
        // shares: the other three regions return nothing.
        const clear =
          line.west > -180 &&
          line.east < 180 &&
          line.south > -85 &&
          line.north < 85 &&
          (line.east < box.west ||
            line.west > box.east ||
            (line.west > box.west &&
              line.east < box.east &&
              (line.north < box.south || line.south > box.north)));
        if (!clear) {
          const regions = [
            { west: -180, east: box.west, south: -85, north: 85 },
            { west: box.east, east: 180, south: -85, north: 85 },
            { west: box.west, east: box.east, south: -85, north: box.south },
            { west: box.west, east: box.east, south: box.north, north: 85 },
          ];
          for (const region of regions)
            for (const coordinates of clip(line.coordinates, region))
              next.push(lineExtent(coordinates));
        } else if (line.settled) {
          next.push(line);
        } else {
          // The first unclipped pass can still move a vertex by a rounding
          // step (a road crossing longitude or latitude 0); once a pass
          // changes nothing, no later one will.
          const coordinates = unclippedLine(line.coordinates);
          if (!coordinates) continue;
          const kept = lineExtent(coordinates);
          kept.settled = sameLine(coordinates, line.coordinates);
          next.push(kept);
        }
      }
      lines = next;
    }
    return lines.map(({ coordinates }) => ({ ...road, coordinates }));
  });
}

/** A classified road failure with a display-safe reason and machine-readable status. */
export class RoadRequestError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message, { cause });
    this.name = 'RoadRequestError';
    this.status = status;
  }
}

// AI tool services import this module, so it marks its English with a local
// msg(); the traffic panel translates the message (controls.js).
const msg = (text) => text;

/** Name the road upstream without exposing raw transport errors or missing codes. */
export function roadRequestError(status, cause) {
  const code = Number.isFinite(status) ? status : null;
  const message =
    code === 429
      ? msg('OpenFreeMap tiles rate-limited')
      : code === 504 || cause?.name === 'TimeoutError'
        ? msg('OpenFreeMap tiles timed out')
        : code === null
          ? msg('OpenFreeMap tiles unavailable')
          : `OpenFreeMap tiles unavailable (HTTP ${code})`;
  return Object.assign(new RoadRequestError(message, { status: code, cause }), {
    retryable: cause?.retryable !== false,
    code: cause?.code,
  });
}

/**
 * Supply tile-derived road geometry and flow availability without Overpass queries.
 *
 * `roadModes` is the host's offer of road sources (default: all three). The
 * layer shows a chip per offered mode (none for a single mode) and never
 * draws one outside it. Without `osm` nothing is simulated: keyless, or with
 * the traffic service unreachable, requests fail with the reason instead of
 * drawing white OpenStreetMap dots.
 */
export function createTrafficSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  tileFetchImpl = (...args) => globalThis.fetch(...args),
  mapTiles = createOpenFreeMapSource({
    fetchImpl: tileFetchImpl,
    selectDecoded: ({ roads }) => ({ roads }),
  }),
  roadModes,
} = {}) {
  const modes = normalizeRoadModes(roadModes);
  const flow = createFlowTileSource({ fetchImpl });
  const api = {
    ...flow,
    roadModes: modes,
    prefetch: () => mapTiles.getMetadata().catch(() => {}),
    resetFlowTileCache() {
      flow.resetFlowTileCache();
      mapTiles.clear();
    },
    async requestOsmRoads(
      box,
      { majorOnly = false, signal, onTile, coverage = box.coverage } = {},
    ) {
      if (
        !validTileBounds(box) ||
        box.north - box.south > 10 ||
        box.east - box.west > 10
      )
        throw new TypeError('A bounded road viewport is required');
      if (coverage) {
        try {
          const tileSnapshot = (tile) =>
            onTile?.({
              roads: tile.roads,
              roadSource: 'OpenStreetMap',
              roadMode: 'osm',
            });
          // Start nearest detail tiles before the coarse pass consumes workers.
          const detailJob =
            !majorOnly && coverage.detail.length
              ? mapTiles
                  .fetchBounds(box, {
                    zoom: 14,
                    tiles: coverage.detail,
                    signal,
                    onTile: onTile ? tileSnapshot : undefined,
                  })
                  .catch((error) => {
                    signal?.throwIfAborted();
                    if (
                      error?.name === 'AbortError' ||
                      error?.retryable === false
                    )
                      throw error;
                    return { tiles: [], loadedTiles: [], partial: true };
                  })
              : null;
          const coarseJob = mapTiles.fetchBounds(box, {
            zoom: 12,
            tiles: coverage.coarse,
            signal,
            onTile: majorOnly && onTile ? tileSnapshot : undefined,
          });
          const [detail, coarse] = await Promise.all([detailJob, coarseJob]);
          signal?.throwIfAborted();
          let roads = coarse.tiles.flatMap((tile) => tile.roads),
            partial = coarse.partial;
          if (detail) {
            roads = [
              ...detail.tiles.flatMap((tile) => tile.roads),
              ...outsideDetailTiles(
                roads,
                detail.loadedTiles || (detail.partial ? [] : coverage.detail),
              ),
            ];
            partial ||= detail.partial;
          }
          const data = {
            roads,
            roadSource: 'OpenStreetMap',
            roadMode: 'osm',
            partial,
            detailLimited: false,
            replace: true,
          };
          if (!majorOnly) onTile?.(data);
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => data,
          };
        } catch (error) {
          signal?.throwIfAborted();
          if (error?.name === 'AbortError') throw error;
          throw roadRequestError(error?.status, error);
        }
      }
      const area = majorOnly ? box : trafficDetailBounds(box);
      const snapshot = (tiles, partial = false) => ({
        roads: tiles
          .flatMap((tile) => tile.roads)
          .flatMap((road) =>
            clipTileLine(road.coordinates, area).map((coordinates) => ({
              ...road,
              coordinates,
            })),
          ),
        roadSource: 'OpenStreetMap',
        roadMode: 'osm',
        partial,
        detailLimited:
          !majorOnly && (area.north !== box.north || area.east !== box.east),
        detailBounds: majorOnly ? null : area,
      });
      let result;
      try {
        result = await mapTiles.fetchBounds(area, {
          zoom: majorOnly ? 12 : 14,
          signal,
          onTile: onTile ? (tile) => onTile(snapshot([tile])) : undefined,
        });
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.name === 'AbortError') throw error;
        throw roadRequestError(error?.status, error);
      }
      const data = snapshot(result.tiles, result.partial);
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
      const start = performance.now();
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
      phaseTiming('status', start);
      return status;
    },
  };
  /**
   * Request roads for the selected road source.
   *
   * `osm` streams OpenFreeMap tiles exactly as before. `tomtom` and `hybrid`
   * wait for the flow snapshot the layer started alongside road acquisition;
   * OpenFreeMap tiles stream meanwhile (Hybrid) and are drawn unfiltered until
   * flow arrives, then one replacing snapshot swaps in TomTom lines and drops
   * the duplicated OpenFreeMap stretches. Later tiles publish only their own
   * fill, so parsing stays incremental. TomTom never requests OpenFreeMap
   * unless the missing key forces the OpenStreetMap fallback.
   *
   * @param {{south:number, west:number, north:number, east:number}} box
   * @param {Object} [options]
   * @param {'tomtom'|'osm'|'hybrid'|null} [options.roadMode] - Requested mode (null = default; outside `roadModes` = default).
   * @param {Promise<{segments:Array, hasKey:boolean, error?:string, partial?:boolean, statusUnavailable?:boolean}>} [options.flowSnapshot]
   * @param {() => boolean} [options.liveModeHint] - Key state if the snapshot misses the pass deadline.
   * @param {number} [options.timeoutSec=20] - Pass deadline, also bounding the snapshot wait.
   * @param {(data:Object) => void} [options.onTile] - Incremental snapshots; `replace` resets.
   */
  api.requestRoads = async (
    box,
    {
      roadMode = null,
      flowSnapshot,
      liveModeHint = () => false,
      onTile,
      ...options
    } = {},
  ) => {
    if (
      !validTileBounds(box) ||
      box.north - box.south > 10 ||
      box.east - box.west > 10
    )
      throw new TypeError('A bounded road viewport is required');
    roadMode = normalizeRoadMode(roadMode, modes);
    if (!roadModesSimulate(modes) && !flowSnapshot)
      throw new TypeError(
        'Road selection requires a flow availability snapshot',
      );
    if (
      roadMode === 'osm' ||
      !flowSnapshot ||
      (modes.length === 1 && modes[0] === 'osm')
    )
      return api.requestOsmRoads(box, { ...options, onTile });
    const signal = options.signal;
    const osm = [];
    let live = null,
      mode = null,
      metadata = {},
      osmError = null,
      tomtom = [],
      fillFor = null;
    const fillMemo = new Map();
    const fill = (roads) =>
      mode === 'hybrid'
        ? roads.flatMap((road) => {
            if (!fillMemo.has(road)) fillMemo.set(road, fillFor(road));
            return fillMemo.get(road);
          })
        : roads;
    // Hybrid without any TomTom line (flow failed, or none here) draws only
    // OpenStreetMap roads, and says so.
    const source = () =>
      !mode || (mode === 'hybrid' && !tomtom.length)
        ? ROAD_SOURCE_LABELS.osm
        : ROAD_SOURCE_LABELS[mode];
    const snapshot = (roads, replace) => ({
      ...metadata,
      roads,
      roadSource: source(),
      roadMode: mode,
      replace,
      partial: Boolean(metadata.partial || osmError || live?.partial),
      roadWarning: osmError && mode !== 'osm' ? osmError.message : null,
    });
    const publish = (roads, replace = false) => {
      if (!signal?.aborted) onTile?.(snapshot(roads, replace));
    };
    const composed = () =>
      mode === 'tomtom' ? tomtom : [...tomtom, ...fill(osm)];
    const loadOsm = async () => {
      try {
        const response = await api.requestOsmRoads(box, {
          ...options,
          onTile: (data) => {
            if (data.replace) osm.splice(0, osm.length, ...data.roads);
            else osm.push(...data.roads);
            metadata = { ...data, roads: undefined };
            // Before flow settles the tile is drawn as plain OpenStreetMap.
            publish(
              data.replace ? composed() : fill(data.roads),
              Boolean(data.replace),
            );
          },
        });
        const data = await response.json();
        metadata = { ...data, roads: undefined };
        // Every tile streams through onTile; adopt the final list if not.
        if (osm.length !== data.roads.length)
          osm.splice(0, osm.length, ...data.roads);
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error;
        osmError = error;
      }
    };
    // A host without OpenStreetMap waits for the key before fetching fill.
    const osmJob =
      roadMode === 'tomtom' ||
      modes.every((entry) => entry === 'tomtom') ||
      !roadModesSimulate(modes)
        ? null
        : loadOsm();
    osmJob?.catch(() => {});
    // The snapshot waits on the status probe and flow tiles; never let it
    // hold the road pass past its own deadline. A late snapshot counts as a
    // flow failure: TomTom mode reports it, Hybrid falls back to OSM roads.
    let deadline;
    live = await Promise.race([
      flowSnapshot,
      new Promise((resolve) => {
        deadline = setTimeout(
          () =>
            resolve({
              segments: [],
              hasKey: Boolean(liveModeHint()),
              error: 'TomTom flow timed out',
            }),
          (options.timeoutSec ?? 20) * 1000,
        );
      }),
    ]).finally(() => clearTimeout(deadline));
    signal?.throwIfAborted();
    if (!live)
      throw new TypeError(
        'Road selection requires a flow availability snapshot',
      );
    mode = resolveRoadMode(roadMode, live.hasKey, modes);
    // A host without OpenStreetMap never simulates: name why no roads draw.
    if (!live.hasKey && !roadModesSimulate(modes))
      throw Object.assign(
        new RoadRequestError(
          live.error ||
            (live.statusUnavailable
              ? msg(
                  'TomTom roads unavailable while the traffic service is unreachable',
                )
              : msg('TomTom roads need a TomTom key')),
        ),
        // A known missing key cannot recover this session; the rest can.
        { retryable: Boolean(live.error || live.statusUnavailable) },
      );
    if (mode === 'tomtom' && live.error) throw new RoadRequestError(live.error);
    if (mode !== 'osm') {
      tomtom = flowSegmentsToRoads(live.segments);
      fillFor = createHybridFill(live.segments);
      publish(composed(), true);
    }
    if (osmJob) await osmJob;
    else if (mode !== 'tomtom') await loadOsm();
    signal?.throwIfAborted();
    if (osmError && (mode === 'osm' || !tomtom.length)) throw osmError;
    const data = snapshot(composed(), true);
    publish(data.roads, true);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => data,
    };
  };
  return api;
}
