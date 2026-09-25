import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { createVectorTileSource } from './vectorTiles.js';
import { clipTileRing, militaryOutlineLines } from './militaryTileGeometry.js';
import { tileToBBox } from '../data/tomtomTiles.js';

const ROAD_TYPES = Object.freeze({
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'residential',
  service: 'unclassified',
});

/** Translate only drivable OpenMapTiles classes; reverse negative one-way geometry. */
export function openMapRoad(coordinates, properties = {}) {
  const type = ROAD_TYPES[properties.class];
  if (!type || coordinates.length < 2) return null;
  const reverse = Number(properties.oneway) === -1;
  return {
    coordinates: reverse ? coordinates.slice().reverse() : coordinates,
    type,
    oneway: reverse || Number(properties.oneway) === 1 ? 1 : 0,
    ramp: properties.ramp === 1,
    brunnel: properties.brunnel || null,
  };
}

/** Area-weighted centroid in tile-scale longitude/latitude coordinates. */
export function polygonCentroid(ring) {
  if (!ring?.length) return null;
  const [ox, oy] = ring[0];
  let area = 0,
    x = 0,
    y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0] - ox,
      ay = ring[j][1] - oy;
    const bx = ring[i][0] - ox,
      by = ring[i][1] - oy;
    const cross = ax * by - bx * ay;
    area += cross;
    x += (ax + bx) * cross;
    y += (ay + by) * cross;
  }
  return Math.abs(area) > 1e-15
    ? [ox + x / (3 * area), oy + y / (3 * area)]
    : ring[0];
}

/** Clip a line to its tile core so buffered copies never animate duplicate dots. */
export function clipTileLine(coords, box) {
  const lines = [];
  let line = [];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1],
      b = coords[i];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    let lo = 0,
      hi = 1;
    const p = [-dx, dx, -dy, dy],
      q = [
        a[0] - box.west,
        box.east - a[0],
        a[1] - box.south,
        box.north - a[1],
      ];
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) hi = -1;
      } else if (p[k] < 0) lo = Math.max(lo, q[k] / p[k]);
      else hi = Math.min(hi, q[k] / p[k]);
    }
    if (lo > hi) {
      if (line.length > 1) lines.push(line);
      line = [];
      continue;
    }
    const start = [a[0] + lo * dx, a[1] + lo * dy],
      end = [a[0] + hi * dx, a[1] + hi * dy];
    const last = line.at(-1);
    if (
      !last ||
      Math.abs(last[0] - start[0]) + Math.abs(last[1] - start[1]) > 1e-10
    ) {
      if (line.length > 1) lines.push(line);
      line = [start];
    }
    line.push(end);
  }
  if (line.length > 1) lines.push(line);
  return lines.filter((points) => {
    let metres = 0;
    for (let i = 1; i < points.length; i++)
      metres +=
        Math.hypot(
          (points[i][0] - points[i - 1][0]) *
            Math.cos((points[i][1] * Math.PI) / 180),
          points[i][1] - points[i - 1][1],
        ) * 111320;
    return metres >= 12;
  });
}

/** Decode road lines and unnamed military polygons from an OpenMapTiles tile. */
export function decodeOpenFreeMapTile(bytes, z, x, y) {
  const tile = new VectorTile(new PbfReader(bytes));
  const roads = [],
    military = [];
  const box = tileToBBox(z, x, y);
  for (const name of ['transportation', 'landuse']) {
    const layer = tile.layers[name];
    if (!layer) continue;
    if (layer.length > 40_000)
      throw new Error('Vector tile feature limit exceeded');
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i),
        props = feature.properties;
      if (
        name === 'transportation'
          ? !ROAD_TYPES[props.class]
          : props.class !== 'military'
      )
        continue;
      const geometry = feature.toGeoJSON(x, y, z).geometry;
      if (name === 'transportation') {
        const lines =
          geometry.type === 'LineString'
            ? [geometry.coordinates]
            : geometry.type === 'MultiLineString'
              ? geometry.coordinates
              : [];
        for (const coords of lines)
          for (const clipped of clipTileLine(coords, box))
            roads.push(openMapRoad(clipped, props));
      } else {
        const polygons =
          geometry.type === 'Polygon'
            ? [geometry.coordinates]
            : geometry.type === 'MultiPolygon'
              ? geometry.coordinates
              : [];
        for (let p = 0; p < polygons.length; p++) {
          const rings = polygons[p]
            .map((r) => clipTileRing(r, box))
            .filter((r) => r.length >= 4);
          const ring = rings[0],
            centroid = polygonCentroid(ring);
          if (!centroid || ring.length < 4) continue;
          const [longitude, latitude] = centroid;
          military.push({
            id: `ofm:${z}/${x}/${y}:${feature.id ?? i}:${p}`,
            kind: 'installation',
            class: 'military_land',
            name: 'Military area',
            latitude,
            longitude,
            footprint: ring,
            rings,
            featureKey:
              feature.id == null
                ? `tile:${z}/${x}/${y}:${i}`
                : String(feature.id),
            tileEpsilon: (box.east - box.west) / feature.extent,
            tileBounds: box,
            tileZoom: z,
            outlineLines: rings.flatMap((r) => militaryOutlineLines(r, box)),
            validation: 'unreviewed',
            sources: [{ name: 'OpenStreetMap', id: `tile:${z}/${x}/${y}` }],
          });
        }
      }
    }
  }
  return { roads, military };
}

/** Construct an immutable-version road/military tile source without starting I/O. */
export function createOpenFreeMapSource(options = {}) {
  return createVectorTileSource({
    tileJsonUrl: 'https://tiles.openfreemap.org/planet',
    allowedOrigin: 'https://tiles.openfreemap.org',
    decode: decodeOpenFreeMapTile,
    maxEntries: 192,
    maxCacheBytes: 64 * 1024 * 1024,
    ...options,
  });
}
