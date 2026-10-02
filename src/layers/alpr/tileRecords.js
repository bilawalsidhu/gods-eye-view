import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { normalizeAlprNode } from './records.js';

/** Map extract attributes without treating an OSM edit date as a field verification. */
export function normalizeAlprTileFeature(feature) {
  const p = feature?.properties || {};
  if (feature?.geometry?.type !== 'Point' || p.osmType !== 'node') return null;
  const [lon, lat] = feature.geometry.coordinates;
  const record = normalizeAlprNode({
    type: 'node',
    id: Number(p.osmId),
    lat,
    lon,
    tags: {
      'surveillance:type': 'ALPR',
      operator: p.operator,
      manufacturer: p.brand,
      'camera:type': p.cameraType,
      'camera:direction': p.direction,
      'surveillance:zone': p.surveillanceZone,
      ref: p.ref,
      check_date: p.check_date,
    },
  });
  return record ? { ...record, osmTimestamp: p.osmTimestamp || null } : null;
}

/** Decode detail-level camera points; geometry-only heatmap tiles are not records. */
export function decodeAlprTile(bytes, z, x, y) {
  const layer = new VectorTile(new PbfReader(bytes)).layers.cameras;
  if (!layer) return [];
  if (layer.length > 40_000)
    throw new Error('Camera tile feature limit exceeded');
  const records = [];
  for (let i = 0; i < layer.length; i++) {
    const record = normalizeAlprTileFeature(
      layer.feature(i).toGeoJSON(x, y, z),
    );
    if (record) records.push(record);
  }
  return records;
}
