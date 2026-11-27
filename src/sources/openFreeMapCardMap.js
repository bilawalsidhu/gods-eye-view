import { LOCALES } from '../i18n/shippedLocales.js';
import { nameKeys } from '../maps/labelNames.js';
import {
  createOpenFreeMapSource,
  registerOpenFreeMapProjection,
} from './openFreeMap.js';

/**
 * The card's maps (the close-up map and pinned map stills) from the same
 * OpenFreeMap tiles the traffic layer and outlines read, through the same
 * bounded fetch and decode owner. A tile is kept as a small plain copy of
 * what the card map draws (its areas, roads, water and the names of places,
 * major roads and water, in a coarse 1024-unit grid).
 */

/** The grid a kept tile's coordinates are rounded to. */
export const CARD_MAP_EXTENT = 1024;

/**
 * The name fields a name is read from: the local name, its Latin form and
 * the name in each language the app is offered in (OpenMapTiles' `name:xx`).
 */
const CARD_MAP_NAME_KEYS = [...new Set(LOCALES.flatMap(nameKeys))];

/** Source layers the card map draws, with the properties it reads. */
const CARD_MAP_TILE_LAYERS = Object.freeze({
  water: ['class'],
  landcover: ['class'],
  landuse: ['class'],
  park: ['class'],
  waterway: ['class'],
  aeroway: ['class'],
  transportation: ['class', 'brunnel'],
  place: ['class', 'rank', ...CARD_MAP_NAME_KEYS],
  transportation_name: ['class', ...CARD_MAP_NAME_KEYS],
  water_name: ['class', ...CARD_MAP_NAME_KEYS],
  // Last: buildings are left out first when a tile is too dense.
  building: [],
});

/** Raw vertices, before grid rounding drops duplicates. */
const TILE_VERTEX_LIMIT = 100_000;
const FEATURE_VERTEX_LIMIT = 16_384;
const LAYER_FEATURE_LIMIT = 40_000;
const MAX_NAME_LENGTH = 128;

/**
 * The vector-tile reader exposes geometry only through eager loadGeometry().
 * Preflight its packed command span before allowing it to allocate Points.
 * Its reader and offset are internal to the pinned vector-tile dependency.
 */
function fitsGeometryBudget(feature, budget) {
  const reader = feature._pbf;
  if (feature._geometry < 0) return false;
  reader.pos = feature._geometry;
  const end = reader.readVarint() + reader.pos;
  if (end > reader.length) return false;
  let remaining = FEATURE_VERTEX_LIMIT;
  while (reader.pos < end) {
    const command = reader.readVarint();
    const id = command & 7;
    const count = Math.floor(command / 8);
    if (!count || count > remaining || count > budget.remaining) return false;
    remaining -= count;
    budget.remaining -= count;
    if (id === 7 && count === 1) continue; // ClosePath emits one vertex.
    if (id !== 1 && id !== 2) return false;
    if (count * 2 > end - reader.pos) return false;
    for (let i = 0; i < count * 2; i++) reader.readVarint();
  }
  return reader.pos === end;
}

/**
 * One parsed OpenMapTiles tile as the card map keeps it: per layer, each
 * feature's type, the properties drawn and its parts as flat `[x, y, ...]`
 * arrays in a {@link CARD_MAP_EXTENT} grid, repeated points dropped.
 * @param {Uint8Array} _bytes
 * @param {number} _z
 * @param {number} _x
 * @param {number} _y
 * @param {{layers: Record<string, any>}} tile The parsed vector tile.
 */
export function projectCardMapTile(_bytes, _z, _x, _y, tile) {
  const layers = {};
  const budget = { remaining: TILE_VERTEX_LIMIT };
  for (const [name, keys] of Object.entries(CARD_MAP_TILE_LAYERS)) {
    const layer = tile?.layers?.[name];
    if (!layer || layer.length > LAYER_FEATURE_LIMIT) continue;
    const k = CARD_MAP_EXTENT / layer.extent;
    const features = [];
    for (let i = 0; i < layer.length && budget.remaining > 0; i++) {
      const feature = layer.feature(i);
      if (
        feature.type < 1 ||
        feature.type > 3 ||
        !fitsGeometryBudget(feature, budget)
      )
        continue;
      const minimum = feature.type === 3 ? 4 : feature.type === 2 ? 2 : 1;
      const parts = [];
      for (const ring of feature.loadGeometry()) {
        const flat = [];
        let px = NaN;
        let py = NaN;
        for (const point of ring) {
          const x = Math.round(point.x * k);
          const y = Math.round(point.y * k);
          if (x === px && y === py && feature.type !== 1) continue;
          flat.push(x, y);
          px = x;
          py = y;
        }
        if (flat.length / 2 >= minimum) parts.push(flat);
      }
      if (!parts.length) continue;
      const properties = {};
      for (const key of keys) {
        const value = feature.properties[key];
        if (value == null) continue;
        properties[key] =
          key.startsWith('name') &&
          typeof value === 'string' &&
          value.length > MAX_NAME_LENGTH
            ? value.slice(0, MAX_NAME_LENGTH).replace(/[\uD800-\uDBFF]$/, '')
            : value;
      }
      features.push({ type: feature.type, properties, parts });
    }
    if (features.length) layers[name] = features;
  }
  return { extent: CARD_MAP_EXTENT, layers };
}

registerOpenFreeMapProjection('cardMap', projectCardMapTile);

/**
 * The card map's OpenFreeMap tile source, through the shared decode owner.
 * @param {object} [options] Passed to `createOpenFreeMapSource`.
 */
export function createCardMapSource(options = {}) {
  return createOpenFreeMapSource({
    projection: 'cardMap',
    maxEntries: 32,
    maxCacheBytes: 8 * 1024 * 1024,
    concurrency: 4,
    maxTiles: 9,
    ...options,
  });
}
