import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { tileLocalToLonLat } from '../../tileMath.js';

// Bound the geometry retained for drawing, picking and Context per tile.
const MAX_TILE_VERTICES = 65_536;

/**
 * Decode a `mly1_public` coverage tile (z11–14) into sequences. The z14
 * `image` layer, which can hold >150k points, is skipped.
 * @param {Uint8Array} bytes
 * @param {{x:number,y:number,z:number}} address
 */
export function decodeCoverageTile(bytes, address) {
  const result = { sequences: [] };
  if (!bytes || !bytes.length) return result;
  const tile = new VectorTile(new PbfReader(bytes));
  const { x, y, z } = address;
  const sequenceLayer = tile.layers.sequence;
  if (sequenceLayer) {
    let remaining = MAX_TILE_VERTICES;
    for (let i = 0; i < sequenceLayer.length && remaining >= 2; i++) {
      const feature = sequenceLayer.feature(i);
      const props = feature.properties || {};
      // A sequence with a capture gap is a multi-line: keep each part as its
      // own line, so no straight segment is drawn across the gap.
      const parts = [];
      for (const line of feature.loadGeometry()) {
        if (remaining < 2) break;
        if (line.length < 2) continue;
        const count = Math.min(line.length, remaining);
        const part = [];
        for (let j = 0; j < count; j++) {
          const point = line[j];
          part.push(
            tileLocalToLonLat(point.x, point.y, sequenceLayer.extent, x, y, z),
          );
        }
        parts.push(part);
        remaining -= count;
      }
      if (!parts.length) continue;
      result.sequences.push({
        id: String(props.id ?? feature.id ?? `${x}/${y}/${i}`),
        capturedAt: Number(props.captured_at) || 0,
        isPano: props.is_pano === true,
        parts,
      });
    }
  }
  return result;
}
