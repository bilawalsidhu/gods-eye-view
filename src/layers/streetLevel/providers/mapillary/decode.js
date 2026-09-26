import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { tileLocalToLonLat } from '../../tileMath.js';

/**
 * Decode a Mapillary coverage tile (`mly1_public`) in the browser.
 * Sequences are LineStrings with capture metadata; the `image` layer is only
 * present at z14 and is skipped unless asked for (it can hold >150k points).
 * @param {Uint8Array} bytes
 * @param {{x:number,y:number,z:number}} address
 * @param {{images?: boolean}} [options]
 * @returns {{sequences: Array<object>, images: Array<object>}}
 */
export function decodeCoverageTile(bytes, address, { images = false } = {}) {
  const result = { sequences: [], images: [], overview: [] };
  if (!bytes || !bytes.length) return result;
  const tile = new VectorTile(new PbfReader(bytes));
  const { x, y, z } = address;
  const sequenceLayer = tile.layers.sequence;
  if (sequenceLayer) {
    for (let i = 0; i < sequenceLayer.length; i++) {
      const feature = sequenceLayer.feature(i);
      const props = feature.properties || {};
      const coordinates = [];
      for (const ring of feature.loadGeometry()) {
        for (const point of ring) {
          coordinates.push(
            tileLocalToLonLat(point.x, point.y, sequenceLayer.extent, x, y, z),
          );
        }
      }
      if (coordinates.length < 2) continue;
      result.sequences.push({
        id: String(props.id ?? feature.id ?? `${x}/${y}/${i}`),
        imageId: props.image_id != null ? String(props.image_id) : null,
        capturedAt: Number(props.captured_at) || 0,
        isPano: props.is_pano === true,
        onFoot: props.foot === true,
        quality: Number.isFinite(props.quality_score)
          ? props.quality_score
          : null,
        coordinates,
      });
    }
  }
  // z0–5 tiles carry an `overview` point layer instead of sequences.
  const overviewLayer = tile.layers.overview;
  if (overviewLayer) {
    for (let i = 0; i < overviewLayer.length; i++) {
      const feature = overviewLayer.feature(i);
      const props = feature.properties || {};
      const point = feature.loadGeometry()?.[0]?.[0];
      if (!point) continue;
      const [lon, lat] = tileLocalToLonLat(
        point.x,
        point.y,
        overviewLayer.extent,
        x,
        y,
        z,
      );
      result.overview.push({
        id: String(props.id ?? feature.id ?? i),
        lon,
        lat,
        capturedAt: Number(props.captured_at) || 0,
        isPano: props.is_pano === true,
        sequenceId: props.sequence_id ? String(props.sequence_id) : null,
      });
    }
  }
  const imageLayer = images ? tile.layers.image : null;
  if (imageLayer) {
    for (let i = 0; i < imageLayer.length; i++) {
      const feature = imageLayer.feature(i);
      const props = feature.properties || {};
      const point = feature.loadGeometry()?.[0]?.[0];
      if (!point) continue;
      const [lon, lat] = tileLocalToLonLat(
        point.x,
        point.y,
        imageLayer.extent,
        x,
        y,
        z,
      );
      result.images.push({
        id: String(props.id ?? feature.id),
        lon,
        lat,
        compassAngle: Number(props.compass_angle) || 0,
        capturedAt: Number(props.captured_at) || 0,
        isPano: props.is_pano === true,
        sequenceId: props.sequence_id ? String(props.sequence_id) : null,
      });
    }
  }
  return result;
}
