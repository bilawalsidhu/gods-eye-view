import { PbfWriter } from 'pbf';

const zigzag = (value) => (value << 1) ^ (value >> 31);

/** Tile-local [x, y] (0..extent) of a lon/lat inside tile (x, y, z). */
export function lonLatToTileLocal([lon, lat], { x, y, z }, extent = 4096) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  const tx = ((lon + 180) / 360) * n;
  const ty =
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [Math.round((tx - x) * extent), Math.round((ty - y) * extent)];
}

/** One MVT layer writer with deduplicated keys and appended values. */
function layerWriter(name, extent) {
  const keys = new Map();
  const values = [];
  const features = [];
  function tags(properties) {
    const out = [];
    for (const [key, value] of Object.entries(properties)) {
      if (value === undefined || value === null) continue;
      if (!keys.has(key)) keys.set(key, keys.size);
      out.push(keys.get(key), values.length);
      values.push(value);
    }
    return out;
  }
  return {
    add(type, geometry, properties, id) {
      features.push({ type, geometry, tags: tags(properties), id });
    },
    write(pbf) {
      pbf.writeVarintField(15, 2);
      pbf.writeStringField(1, name);
      pbf.writeVarintField(5, extent);
      for (const feature of features)
        pbf.writeMessage(
          2,
          (f, out) => {
            if (Number.isInteger(f.id)) out.writeVarintField(1, f.id);
            out.writePackedVarint(2, f.tags);
            out.writeVarintField(3, f.type);
            out.writePackedVarint(4, f.geometry);
          },
          feature,
        );
      for (const key of keys.keys()) pbf.writeStringField(3, key);
      for (const value of values)
        pbf.writeMessage(
          4,
          (v, out) => {
            if (typeof v === 'boolean') out.writeBooleanField(7, v);
            else if (typeof v === 'number') out.writeVarintField(5, v);
            else out.writeStringField(1, String(v));
          },
          value,
        );
    },
  };
}

/** MVT MoveTo/LineTo commands; the cursor carries over between parts. */
function lineGeometry(parts) {
  const out = [];
  let cx = 0;
  let cy = 0;
  for (const part of parts) {
    if (part.length < 2) continue;
    const [x0, y0] = part[0];
    out.push(9, zigzag(x0 - cx), zigzag(y0 - cy));
    cx = x0;
    cy = y0;
    out.push(((part.length - 1) << 3) | 2);
    for (const [x, y] of part.slice(1)) {
      out.push(zigzag(x - cx), zigzag(y - cy));
      cx = x;
      cy = y;
    }
  }
  return out;
}

/**
 * Encode a `mly1_public`-shaped tile from lon/lat features, for tests and
 * the hermetic QA gate.
 * @param {{x: number, y: number, z: number}} tile
 * @param {{sequences?: Array<{id: string, capturedAt?: number, isPano?: boolean, parts: Array<Array<[number, number]>>}>, extent?: number}} [content]
 */
export function encodeCoverageTile(
  tile,
  { sequences = [], extent = 4096 } = {},
) {
  const pbf = new PbfWriter();
  if (sequences.length) {
    const layer = layerWriter('sequence', extent);
    for (const sequence of sequences)
      layer.add(
        2,
        lineGeometry(
          sequence.parts.map((part) =>
            part.map((point) => lonLatToTileLocal(point, tile, extent)),
          ),
        ),
        {
          id: sequence.id,
          captured_at: sequence.capturedAt ?? Date.now(),
          is_pano: sequence.isPano === true,
        },
      );
    pbf.writeMessage(3, (_, out) => layer.write(out), null);
  }
  return new Uint8Array(pbf.finish());
}
