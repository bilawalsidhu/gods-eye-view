import * as Cesium from 'cesium';
import { decodePackGeoJSON } from '../../director/packs/geojson.js';
const xyz = (p) => Cesium.Cartesian3.fromDegrees(...p);

/** Render a bounded geometry pack in owned batches; no asynchronous entity geometry or update loop. */
export function renderPackGeometry({ asset, pack }, handle) {
  if (!['application/json', 'application/geo+json'].includes(asset.mimeType))
    throw new Error('Expected GeoJSON');
  const features = decodePackGeoJSON(asset.bytes);
  const polygons = [];
  let lines;
  for (const feature of features) {
    const id = { packId: pack.id, featureId: feature.id };
    if (feature.type === 'Point') {
      const entity = handle.add({
        name: `${pack.id} / ${feature.id}`,
        position: xyz(feature.coordinates),
        point: {
          pixelSize: 12,
          color: Cesium.Color.CYAN,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
        },
      });
      handle.feature?.(id, entity);
    } else if (feature.type === 'LineString') {
      handle.feature?.(id, id);
      if (!lines) {
        lines = new Cesium.PolylineCollection();
        handle.primitive(lines);
      }
      lines.add({
        id,
        positions: feature.coordinates.map(xyz),
        width: 4,
        material: Cesium.Material.fromType('Color', {
          color: Cesium.Color.CYAN,
        }),
      });
    } else {
      handle.feature?.(id, id);
      polygons.push(
        new Cesium.GeometryInstance({
          id,
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              feature.coordinates[0].map(xyz),
              feature.coordinates
                .slice(1)
                .map((ring) => new Cesium.PolygonHierarchy(ring.map(xyz))),
            ),
            perPositionHeight: true,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            arcType: Cesium.ArcType.GEODESIC,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.CYAN.withAlpha(0.35),
            ),
          },
        }),
      );
    }
  }
  if (polygons.length)
    handle.primitive(
      new Cesium.Primitive({
        asynchronous: false,
        geometryInstances: polygons,
        appearance: new Cesium.PerInstanceColorAppearance({
          translucent: true,
          flat: true,
          closed: false,
        }),
      }),
    );
}
