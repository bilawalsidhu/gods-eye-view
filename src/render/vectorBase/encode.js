/**
 * @module render/vectorBase/encode
 * @description A small Mapbox Vector Tile encoder, for fixtures: the tests
 * and conformance checks build the tiles the painter reads with it.
 */
import { PbfWriter } from 'pbf';

const TYPES = { Point: 1, LineString: 2, Polygon: 3 };

const zigzag = (n) => (n << 1) ^ (n >> 31);
const command = (id, count) => (id & 7) | (count << 3);

/** A feature's geometry as MVT commands. */
function geometryOf(type, parts) {
  const out = [];
  let cx = 0;
  let cy = 0;
  const move = ([x, y]) => {
    out.push(zigzag(x - cx), zigzag(y - cy));
    cx = x;
    cy = y;
  };
  if (type === 'Point') {
    const points = parts.flat();
    out.push(command(1, points.length));
    points.forEach(move);
    return out;
  }
  for (const part of parts) {
    // A ring's closing point is the close command.
    const points = type === 'Polygon' ? part.slice(0, -1) : part;
    out.push(command(1, 1));
    move(points[0]);
    out.push(command(2, points.length - 1));
    points.slice(1).forEach(move);
    if (type === 'Polygon') out.push(command(7, 1));
  }
  return out;
}

/**
 * Encode layers of features as a vector tile.
 * @param {Record<string, Array<{type: 'Point'|'LineString'|'Polygon',
 *   geometry: number[][][], properties?: Record<string, string|number|boolean>,
 *   id?: number}>>} layers Geometry in tile units (`extent` 4096), polygon
 *   rings closed.
 * @param {number} [extent]
 * @returns {Uint8Array}
 */
export function encodeVectorTile(layers, extent = 4096) {
  const pbf = new PbfWriter();
  for (const [name, features] of Object.entries(layers)) {
    const keys = [];
    const values = [];
    const index = (list, v) => {
      let i = list.indexOf(v);
      if (i < 0) i = list.push(v) - 1;
      return i;
    };
    const encoded = features.map((f) => ({
      ...f,
      tags: Object.entries(f.properties ?? {}).flatMap(([k, v]) => [
        index(keys, k),
        index(values, v),
      ]),
    }));
    pbf.writeMessage(3, (_, p) => {
      p.writeVarintField(15, 2);
      p.writeStringField(1, name);
      for (const f of encoded)
        p.writeMessage(2, (__, q) => {
          if (f.id !== undefined) q.writeVarintField(1, f.id);
          q.writePackedVarint(2, f.tags);
          q.writeVarintField(3, TYPES[f.type]);
          q.writePackedVarint(4, geometryOf(f.type, f.geometry));
        });
      for (const k of keys) p.writeStringField(3, k);
      for (const v of values)
        p.writeMessage(4, (__, q) => {
          if (typeof v === 'string') q.writeStringField(1, v);
          else if (typeof v === 'boolean') q.writeBooleanField(7, v);
          else if (Number.isInteger(v)) q.writeSVarintField(6, v);
          else q.writeDoubleField(3, v);
        });
      p.writeVarintField(5, extent);
    });
  }
  return pbf.finish();
}
