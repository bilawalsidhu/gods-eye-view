import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import {
  clipTileLine,
  createOpenFreeMapSource,
  registerOpenFreeMapProjection,
} from './openFreeMap.js';
import { tileToBBox } from '../data/tomtomTiles.js';
import {
  approximateDistanceM,
  ringAreaM2,
  closeRing,
} from './featureGeometry.js';
import { phaseTiming } from './phaseTiming.js';

/**
 * Street and building outlines from the same OpenFreeMap z14 vector tiles the
 * traffic layer reads. No new tile provider: the source below points at the
 * same immutable tile URLs and bounded decoded owner. Traffic prepares the
 * outline projection in idle time; nothing here starts provider I/O without
 * an explicit traffic or outline ask.
 */

/** Tile zoom used for outlines (the highest OpenMapTiles zoom with buildings). */
export const OUTLINE_TILE_ZOOM = 14;

/** Radius around the geocoded point searched for a named street. */
export const STREET_RADIUS_M = 1500;

/** Bounds on what one street ask can return. */
const STREET_MAX_CHAINS = 12;
const STREET_MAX_POINTS = 4000;
const STREET_MIN_CHAIN_M = 20;
const JOIN_TOLERANCE_M = 3;

/** How far from the point a building may be and still be "this building". */
export const BUILDING_MAX_DISTANCE_M = 40;

const LAYER_FEATURE_LIMIT = 40_000;

/** Area classes (OpenMapTiles `class`, or `subclass` for landcover) that can be grounds. */
const GROUNDS_AREA_CLASSES = Object.freeze({
  park: new Set(['park', 'nature_reserve', 'protected_area', 'national_park']),
  landuse: new Set([
    'school',
    'university',
    'college',
    'hospital',
    'cemetery',
    'stadium',
    'zoo',
    'theme_park',
    'military',
    'religious',
    'pitch',
    'track',
    'playground',
  ]),
  landcover: new Set(['park', 'garden', 'grass', 'recreation_ground']),
});

/** Lines of one tile's `transportation_name` layer and polygons of `building`. */
export function decodeOpenFreeMapOutlineTile(
  bytes,
  z,
  x,
  y,
  parsedTile = null,
) {
  const tile = parsedTile || new VectorTile(new PbfReader(bytes));
  const box = tileToBBox(z, x, y);
  const streets = [];
  const streetsStart = performance.now();
  const names = tile.layers.transportation_name;
  if (names) {
    if (names.length > LAYER_FEATURE_LIMIT)
      throw new Error('Vector tile feature limit exceeded');
    for (let i = 0; i < names.length; i++) {
      const feature = names.feature(i);
      const props = feature.properties;
      const name = props.name || props['name:latin'] || props.name_en;
      if (!name) continue;
      const geometry = feature.toGeoJSON(x, y, z).geometry;
      const lines =
        geometry.type === 'LineString'
          ? [geometry.coordinates]
          : geometry.type === 'MultiLineString'
            ? geometry.coordinates
            : [];
      // Clip to the tile core so neighbouring tiles' buffers never duplicate.
      for (const line of lines)
        for (const clipped of clipTileLine(line, box))
          streets.push({
            name: String(name),
            nameEn: props.name_en ? String(props.name_en) : null,
            class: props.class || null,
            coordinates: clipped,
          });
    }
  }
  phaseTiming(
    'street-extract',
    streetsStart,
    {
      tile: `${z}/${x}/${y}`,
      features: names?.length || 0,
      streets: streets.length,
    },
    'outlines',
  );
  const polygonsStart = performance.now();
  const buildings = decodePolygons(
    tile.layers.building,
    z,
    x,
    y,
    null,
    (props) => {
      const height = Number(props.render_height);
      return { heightM: Number.isFinite(height) && height > 0 ? height : null };
    },
  );
  // Open areas that can enclose grounds: parks, landuse and park-like cover.
  const areas = [];
  for (const name of ['park', 'landuse', 'landcover']) {
    areas.push(
      ...decodePolygons(
        tile.layers[name],
        z,
        x,
        y,
        (props) =>
          GROUNDS_AREA_CLASSES[name].has(String(props.subclass || props.class)),
        (props) => ({
          layer: name,
          class: String(props.subclass || props.class),
          name: props.name ? String(props.name) : null,
        }),
      ),
    );
  }
  phaseTiming(
    'polygon-extract',
    polygonsStart,
    {
      tile: `${z}/${x}/${y}`,
      buildings: buildings.length,
      areas: areas.length,
    },
    'outlines',
  );
  return { streets, buildings, areas };
}

registerOpenFreeMapProjection('outlines', decodeOpenFreeMapOutlineTile);

/** Tile pixel -> longitude/latitude, exactly as vector-tile's toGeoJSON projects. */
function pixelToLonLat(px, py, extent, z, x, y) {
  const size = extent * 2 ** z;
  const lon = ((extent * x + px) * 360) / size - 180;
  const y2 = 180 - ((extent * y + py) * 360) / size;
  const lat = (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
  return [lon, lat];
}

/**
 * Polygons of one layer with their identity and completeness.
 *
 * Tiles cut geometry at a buffer beyond the tile edge. A polygon with a vertex
 * on that cut line is a fragment of something larger: it keeps its feature id
 * and tile, and is marked `clipped` so it is never used as a whole outline. A
 * neighbouring tile may carry the same feature complete within its buffer.
 */
function decodePolygons(layer, z, x, y, keep, describe) {
  if (!layer) return [];
  if (layer.length > LAYER_FEATURE_LIMIT)
    throw new Error('Vector tile feature limit exceeded');
  const extent = layer.extent || 4096;
  // The cut lines are the layer's extreme coordinates beyond the tile core.
  let minX = 0;
  let minY = 0;
  let maxX = extent;
  let maxY = extent;
  for (let i = 0; i < layer.length; i++)
    for (const ring of layer.feature(i).loadGeometry())
      for (const point of ring) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
  const [westCut, northCut] = pixelToLonLat(minX, minY, extent, z, x, y);
  const [eastCut, southCut] = pixelToLonLat(maxX, maxY, extent, z, x, y);
  const eps = 1e-9;
  const onCut = ([lon, lat]) =>
    (minX < 0 && Math.abs(lon - westCut) < eps) ||
    (maxX > extent && Math.abs(lon - eastCut) < eps) ||
    (minY < 0 && Math.abs(lat - northCut) < eps) ||
    (maxY > extent && Math.abs(lat - southCut) < eps);
  const out = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const props = feature.properties;
    if (keep && !keep(props)) continue;
    const geometry = feature.toGeoJSON(x, y, z).geometry;
    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    for (let part = 0; part < polygons.length; part++) {
      const rings = polygons[part];
      if (!Array.isArray(rings?.[0]) || rings[0].length < 4) continue;
      out.push({
        rings,
        id: feature.id ?? null,
        part,
        tile: `${z}/${x}/${y}`,
        clipped: rings[0].some(onCut),
        ...describe(props),
      });
    }
  }
  return out;
}

/** Construct the outline tile source: same OpenFreeMap tiles, outline decode. */
export function createOpenFreeMapOutlineSource(options = {}) {
  return createOpenFreeMapSource({
    projection: 'outlines',
    maxEntries: 32,
    maxCacheBytes: 16 * 1024 * 1024,
    ...options,
  });
}

/** Geographic box of `radiusM` around a point. */
export function boxAround(lat, lon, radiusM) {
  const dLat = radiusM / 111_320;
  const dLon =
    radiusM / (111_320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return {
    south: Math.max(-85, lat - dLat),
    north: Math.min(85, lat + dLat),
    west: Math.max(-180, lon - dLon),
    east: Math.min(180, lon + dLon),
  };
}

const STREET_WORDS = Object.freeze({
  st: 'street',
  str: 'street',
  ave: 'avenue',
  av: 'avenue',
  blvd: 'boulevard',
  rd: 'road',
  dr: 'drive',
  ln: 'lane',
  hwy: 'highway',
  pkwy: 'parkway',
  pl: 'place',
  ct: 'court',
  sq: 'square',
  n: 'north',
  s: 'south',
  e: 'east',
  w: 'west',
});

const DIRECTIONS = new Set(['north', 'south', 'east', 'west']);

/** Comparable street name: accents off, abbreviations expanded. */
export function normalizeStreetName(value) {
  return String(value ?? '')
    .split(',')[0]
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((word, index) => !(index === 0 && word === 'the'))
    .map((word) => STREET_WORDS[word] || word)
    .join(' ');
}

/**
 * Whether a tile street name answers the asked street. Exact after
 * normalization; otherwise the same name with only a leading direction added
 * ("North Congress Avenue" for "Congress Avenue") — never a different street
 * that merely shares a word.
 */
export function streetNameMatches(candidate, asked) {
  const want = normalizeStreetName(asked);
  if (!want) return false;
  const have = normalizeStreetName(candidate);
  if (have === want) return true;
  const [first, ...rest] = have.split(' ');
  return DIRECTIONS.has(first) && rest.join(' ') === want;
}

const lengthM = (line) => {
  let total = 0;
  for (let i = 1; i < line.length; i++)
    total += approximateDistanceM(
      line[i - 1][1],
      line[i - 1][0],
      line[i][1],
      line[i][0],
    );
  return total;
};

const near = (a, b) =>
  approximateDistanceM(a[1], a[0], b[1], b[0]) <= JOIN_TOLERANCE_M;

/** Join line pieces whose ends meet into as few chains as possible. */
export function mergeLineSegments(segments) {
  const pending = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const chains = [];
  while (pending.length) {
    let chain = pending.shift();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pending.length; i++) {
        const s = pending[i];
        const head = chain[0];
        const tail = chain[chain.length - 1];
        if (near(tail, s[0])) chain = chain.concat(s.slice(1));
        else if (near(tail, s[s.length - 1]))
          chain = chain.concat(s.slice(0, -1).reverse());
        else if (near(head, s[s.length - 1]))
          chain = s.slice(0, -1).concat(chain);
        else if (near(head, s[0])) chain = s.slice(1).reverse().concat(chain);
        else continue;
        pending.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains;
}

/**
 * The asked street near a point as a bounded set of merged polylines, longest
 * first, or null when no tile street carries that name.
 *
 * @param {Array<{tiles?: object[], streets?: object[]}>|object[]} tiles  Decoded tiles.
 * @param {{name: string, lat: number, lon: number, radiusM?: number}} ask
 * @returns {null | {name: string, lines: Array<Array<[number, number]>>}}
 */
export function streetFromTiles(
  tiles,
  { name, lat, lon, radiusM = STREET_RADIUS_M },
) {
  const pieces = [];
  let matchedName = null;
  const extent = boxAround(lat, lon, radiusM);
  for (const tile of tiles || []) {
    for (const street of tile?.streets || []) {
      if (
        !streetNameMatches(street.name, name) &&
        !(street.nameEn && streetNameMatches(street.nameEn, name))
      )
        continue;
      // Segment distance, not vertex distance: a long straight piece through
      // the point has no vertex near it.
      if (distanceToLineM(lon, lat, street.coordinates) > radiusM) continue;
      // Only what lies within the search extent is drawn.
      const clipped = clipTileLine(street.coordinates, extent);
      if (!clipped.length) continue;
      matchedName ||= street.name;
      pieces.push(...clipped);
    }
  }
  if (!pieces.length) return null;
  const chains = mergeLineSegments(pieces)
    .map((line) => ({ line, length: lengthM(line) }))
    .filter((entry) => entry.length >= STREET_MIN_CHAIN_M)
    .sort((a, b) => b.length - a.length)
    .slice(0, STREET_MAX_CHAINS);
  const lines = [];
  let points = 0;
  for (const { line } of chains) {
    if (points + line.length > STREET_MAX_POINTS) break;
    lines.push(line);
    points += line.length;
  }
  return lines.length ? { name: matchedName, lines } : null;
}

function insideRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi
    )
      inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
function insidePolygon(lon, lat, rings) {
  if (!insideRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++)
    if (insideRing(lon, lat, rings[i])) return false;
  return true;
}

/** Distance (m) from a point to the nearest edge of any ring of a polygon. */
function distanceToPolygonM(lon, lat, rings) {
  return Math.min(...rings.map((ring) => distanceToLineM(lon, lat, ring)));
}

/** Distance (m) from a point to the nearest segment of a line or ring. */
function distanceToLineM(lon, lat, ring) {
  const mLat = 111_320;
  const mLon = mLat * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const ax = (ring[i - 1][0] - lon) * mLon;
    const ay = (ring[i - 1][1] - lat) * mLat;
    const bx = (ring[i][0] - lon) * mLon;
    const by = (ring[i][1] - lat) * mLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/**
 * The building at a point: the smallest footprint containing it, else the
 * nearest within `maxDistanceM`, else null.
 *
 * @returns {null | {ring: Array<[number, number]>, rings: Array<Array<[number, number]>>, heightM: number|null, contains: boolean}}
 */
export function buildingFromTiles(
  tiles,
  { lat, lon, maxDistanceM = BUILDING_MAX_DISTANCE_M },
) {
  let containing = null;
  let fragmentContains = false;
  let nearest = null;
  for (const tile of tiles || []) {
    for (const building of tile?.buildings || []) {
      if (insidePolygon(lon, lat, building.rings)) {
        // A fragment cut at a tile edge is never the whole footprint.
        if (building.clipped) {
          fragmentContains = true;
          continue;
        }
        const area = ringAreaM2(building.rings[0]);
        if (!containing || area < containing.area)
          containing = { building, area };
      } else if (!building.clipped) {
        const distance = distanceToPolygonM(lon, lat, building.rings);
        if (
          distance <= maxDistanceM &&
          (!nearest || distance < nearest.distance)
        )
          nearest = { building, distance };
      }
    }
  }
  // The point is on a building only seen in pieces: no neighbour stands in.
  const pick =
    containing?.building || (fragmentContains ? null : nearest?.building);
  if (!pick) return null;
  const rings = pick.rings.map((ring) =>
    closeRing(ring.map((p) => [p[0], p[1]])),
  );
  return {
    ring: rings[0],
    rings,
    heightM: pick.heightM,
    contains: Boolean(containing),
  };
}

/**
 * The open area enclosing grounds at a point: the smallest park, landuse or
 * park-like cover polygon that contains it and is at least grounds-sized.
 * Tiles carry no names for these, so this is only used after a named lookup
 * found nothing better.
 */
export function enclosingAreaFromTiles(
  tiles,
  { lat, lon, minAreaM2 = 20_000, maxAreaM2 = 60e6 },
) {
  let best = null;
  for (const tile of tiles || []) {
    for (const area of tile?.areas || []) {
      // Grounds ENCLOSE: the outer boundary counts, since a hole in grounds is
      // typically the building the ask is about (the Capitol inside its lawn).
      if (area.clipped || !insideRing(lon, lat, area.rings[0])) continue;
      const size = ringAreaM2(area.rings[0]);
      if (size < minAreaM2 || size > maxAreaM2) continue;
      if (!best || size < best.size) best = { area, size };
    }
  }
  if (!best) return null;
  const rings = best.area.rings.map((ring) =>
    closeRing(ring.map((p) => [p[0], p[1]])),
  );
  return { ring: rings[0], rings, class: best.area.class, areaM2: best.size };
}
