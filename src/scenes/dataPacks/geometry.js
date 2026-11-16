import { decodePackGeoJSON } from '../../director/packs/geojson.js';
import { fromDegrees } from '../../geo/ellipsoid.js';

const CYAN = [0, 1, 1, 1];
const BLACK = [0, 0, 0, 1];
const lonLatHeight = ([lon, lat, height]) => ({ lon, lat, height });

/**
 * A feature's item id. Code that reads a pick's bare item id (the pick
 * registry, vessel and flight lookups) must never take a pack feature for a
 * live contact, so the id is namespaced, never the feature's own.
 */
export const packItemId = (packId, featureId) =>
  `data-pack:${JSON.stringify([packId, featureId])}`;

/**
 * Render a bounded geometry pack as one draw set per kind (points, lines,
 * polygons); no asynchronous geometry or update loop. Each feature's pick
 * target is its set and item id.
 */
export function renderPackGeometry({ asset, pack }, handle) {
  if (!['application/json', 'application/geo+json'].includes(asset.mimeType))
    throw new Error('Expected GeoJSON');
  const features = decodePackGeoJSON(asset.bytes);
  const items = { points: [], lines: [], shapes: [] };
  const kinds = new Map();
  for (const feature of features) {
    const id = packItemId(pack.id, feature.id);
    if (feature.type === 'Point') {
      kinds.set(feature.id, 'points');
      items.points.push({
        id,
        pos: lonLatHeight(feature.coordinates),
        pixelSize: 12,
        color: CYAN,
        outlineColor: BLACK,
        outlineWidth: 2,
      });
    } else if (feature.type === 'LineString') {
      kinds.set(feature.id, 'lines');
      items.lines.push({
        id,
        positions: feature.coordinates.map((p) => fromDegrees(...p)),
        widthPx: 4,
        mode: '3d',
        style: { kind: 'solid', color: CYAN },
      });
    } else {
      kinds.set(feature.id, 'shapes');
      items.shapes.push({
        id,
        geometry: {
          kind: 'polygon',
          rings: feature.coordinates.map((ring) => ring.map(lonLatHeight)),
          perPositionHeight: true,
        },
        fill: [0, 1, 1, 0.35],
      });
    }
  }
  const sets = {};
  for (const kind of ['points', 'lines', 'shapes'])
    if (items[kind].length) sets[kind] = handle.draw(kind, items[kind]);
  for (const feature of features)
    handle.feature?.(
      { packId: pack.id, featureId: feature.id },
      {
        set: sets[kinds.get(feature.id)],
        id: packItemId(pack.id, feature.id),
      },
    );
}
