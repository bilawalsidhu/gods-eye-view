/**
 * @module layers/riverLevels/rivers
 *
 * River lines for the gauges: the OpenStreetMap waterways in the OpenFreeMap
 * vector tiles the app already reads (no key, no Overpass). A stretch of
 * river takes the band colour of the nearest gauge on the same river, so a
 * whole river reads at a glance: the Rhine in the brown of a record low, one
 * reach red in a flood. A river with no gauge of its own stays undrawn.
 *
 * Pure apart from tile I/O, which `createRiverWaterwaySource` delegates to the
 * shared OpenFreeMap source.
 */

import {
  clipTileLine,
  createOpenFreeMapSource,
  registerOpenFreeMapProjection,
} from '../../sources/openFreeMap.js';
import { tileToBBox } from '../../data/tomtomTiles.js';

export const RIVER_TILE_PROJECTION = 'river-waterways';
/**
 * Below this camera height the lines come from detailed (z9) tiles, as long
 * as the gauges in view need no more than `RIVER_TILE_LIMIT` of them.
 */
export const RIVER_DETAIL_MAX_HEIGHT_M = 900_000;
/** Up to this height, generalized (z6) tiles still carry the big rivers. */
export const RIVER_OVERVIEW_MAX_HEIGHT_M = 4_500_000;
/** A gauge colours its river this far up- and downstream at most. */
export const RIVER_STRETCH_MAX_KM = 40;
export const RIVER_TILE_LIMIT = 40;

const WATERWAY_CLASSES = new Set(['river', 'canal']);
const MAX_WATERWAY_FEATURES = 20_000;

/** Lower-case, accent-free, punctuation-free: "Main-Donau-Kanal" → "main donau kanal". */
export function normalizeRiverName(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Every name a waterway carries (name, name:de, name_en, …), normalized. */
export function riverNamesOf(properties = {}) {
  const names = new Set();
  for (const [key, value] of Object.entries(properties)) {
    if (key !== 'name' && !/^name[:_]/.test(key)) continue;
    const name = normalizeRiverName(value);
    if (name) names.add(name);
  }
  return [...names];
}

/**
 * OpenFreeMap tile projection: named river and canal lines, clipped to the
 * tile so neighbouring tiles never draw the same stretch twice.
 * @returns {Array<{names: string[], coords: Array<[number, number]>}>}
 */
export function decodeRiverTile(bytes, z, x, y, tile) {
  const layer = tile?.layers?.waterway;
  if (!layer) return [];
  if (layer.length > MAX_WATERWAY_FEATURES)
    throw new Error('Vector tile feature limit exceeded');
  const box = tileToBBox(z, x, y);
  const lines = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const props = feature.properties || {};
    if (!WATERWAY_CLASSES.has(props.class)) continue;
    const names = riverNamesOf(props);
    if (!names.length) continue;
    const geometry = feature.toGeoJSON(x, y, z).geometry;
    const parts =
      geometry?.type === 'LineString'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    for (const coords of parts)
      for (const clipped of clipTileLine(coords, box))
        lines.push({
          names,
          coords: clipped.map(([lon, lat]) => [
            Math.round(lon * 1e6) / 1e6,
            Math.round(lat * 1e6) / 1e6,
          ]),
        });
  }
  return lines;
}

registerOpenFreeMapProjection(RIVER_TILE_PROJECTION, decodeRiverTile);

/** River lines from the shared OpenFreeMap tiles; starts no I/O. */
export function createRiverWaterwaySource(options = {}) {
  return createOpenFreeMapSource({
    projection: RIVER_TILE_PROJECTION,
    maxTiles: RIVER_TILE_LIMIT,
    maxEntries: 96,
    maxCacheBytes: 12 * 1024 * 1024,
    ...options,
  });
}

/**
 * Which tiles to load for a view: detailed ones while they stay few enough
 * to cover every gauge in view (a partial patch in the middle of the screen
 * reads as a bug), else generalized ones, which carry only the big rivers.
 * Null from space, where lines would be noise.
 * @returns {{zoom: number, tiles: Array<{z: number, x: number, y: number}>}|null}
 */
export function riverTilePlan(
  stations,
  view,
  cameraHeightM,
  limit = RIVER_TILE_LIMIT,
) {
  if (
    !Number.isFinite(cameraHeightM) ||
    cameraHeightM >= RIVER_OVERVIEW_MAX_HEIGHT_M
  )
    return null;
  if (cameraHeightM < RIVER_DETAIL_MAX_HEIGHT_M) {
    const detailed = riverTilesFor(stations, view, 9, Infinity);
    if (detailed.length <= limit) return { zoom: 9, tiles: detailed };
  }
  return { zoom: 6, tiles: riverTilesFor(stations, view, 6, limit) };
}

function tileOf(lon, lat, z) {
  const n = 2 ** z;
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return {
    z,
    x: Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n))),
    y: Math.min(
      n - 1,
      Math.max(
        0,
        Math.floor(
          ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
        ),
      ),
    ),
  };
}

/**
 * The tiles worth loading: those holding a referenced gauge in view, and
 * their neighbours (a reach between two gauges crosses tiles), kept to the
 * view and nearest its centre first.
 * @param {object[]} stations Normalized stations.
 * @param {{west: number, south: number, east: number, north: number}} view Degrees.
 * @returns {Array<{z: number, x: number, y: number}>}
 */
export function riverTilesFor(stations, view, zoom, limit = RIVER_TILE_LIMIT) {
  if (!view || !Number.isInteger(zoom) || !(view.east > view.west)) return [];
  const n = 2 ** zoom;
  const min = tileOf(view.west, view.north, zoom);
  const max = tileOf(view.east, view.south, zoom);
  const keys = new Map();
  for (const station of stations || []) {
    if (!station || station.band === 'unknown') continue;
    if (
      station.lon < view.west ||
      station.lon > view.east ||
      station.lat < view.south ||
      station.lat > view.north
    )
      continue;
    const home = tileOf(station.lon, station.lat, zoom);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const x = home.x + dx;
        const y = home.y + dy;
        if (x < min.x || x > max.x || y < min.y || y > max.y) continue;
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        keys.set(`${x}/${y}`, { z: zoom, x, y });
      }
  }
  const cx = (min.x + max.x) / 2;
  const cy = (min.y + max.y) / 2;
  return [...keys.values()]
    .sort(
      (a, b) =>
        Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy) ||
        a.x - b.x ||
        a.y - b.y,
    )
    .slice(0, Math.max(0, limit));
}

const KM_PER_DEGREE = 111.32;

function nearestGauge([lon, lat], gauges, maxKm) {
  const cos = Math.cos((lat * Math.PI) / 180);
  let best = null;
  let bestKm = maxKm;
  for (const gauge of gauges) {
    const km = Math.hypot(
      (gauge.lon - lon) * cos * KM_PER_DEGREE,
      (gauge.lat - lat) * KM_PER_DEGREE,
    );
    if (km <= bestKm) {
      best = gauge;
      bestKm = km;
    }
  }
  return best;
}

/**
 * Split river lines into stretches, each owned by the nearest gauge on the
 * same river (matched by name) within `maxKm`. Neighbouring stretches share
 * their boundary point, so the river stays continuous where the colour
 * changes. Gauges without references colour nothing.
 * @returns {Array<{stationId: string, band: string, coords: Array<[number, number]>}>}
 */
export function riverStretches(
  lines,
  stations,
  { maxKm = RIVER_STRETCH_MAX_KM } = {},
) {
  const byName = new Map();
  for (const station of stations || []) {
    if (!station || station.band === 'unknown') continue;
    const names = new Set(
      [station.river, station.riverNative].map(normalizeRiverName),
    );
    for (const name of names) {
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(station);
    }
  }
  const stretches = [];
  const close = (run) => {
    if (run?.station && run.coords.length >= 2)
      stretches.push({
        stationId: run.station.id,
        band: run.station.band,
        coords: run.coords,
      });
  };
  for (const line of lines || []) {
    const gauges = [
      ...new Set((line?.names || []).flatMap((n) => byName.get(n) || [])),
    ];
    if (!gauges.length) continue;
    let run = null;
    for (const point of line.coords || []) {
      const station = nearestGauge(point, gauges, maxKm);
      if (run && run.station === station) {
        run.coords.push(point);
        continue;
      }
      if (run) {
        run.coords.push(point);
        close(run);
      }
      run = { station, coords: [point] };
    }
    close(run);
  }
  return stretches;
}
