import * as Cesium from 'cesium';
const xyz = (p) => Cesium.Cartesian3.fromDegrees(...p);

/** Render decoded pack geometry in owned batches; no asynchronous entity geometry or update loop. */
export function renderDecodedGeometry(features, pack, handle) {
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
