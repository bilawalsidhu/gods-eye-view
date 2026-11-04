import * as Cesium from 'cesium';

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

/**
 * Ground zones on a Cesium globe: each row's polygons (GeoJSON-style rings,
 * outline first) as a translucent fill under a ground-clamped outline, in
 * the row's CSS colour (`colorOf(row)`). Entity ids are
 * `${idPrefix}:${row.stableId}:${index}`. Fire perimeters and drone airspace
 * draw this way.
 */
export function createZonesCesiumRenderer({
  viewer,
  screenSpaceEventHandlerFactory,
  name,
  idPrefix,
  colorOf,
}) {
  const dataSource = new Cesium.CustomDataSource(name);
  dataSource.show = false;
  viewer.dataSources.add(dataSource);
  return {
    setVisible(show) {
      dataSource.show = show;
    },
    pick(click) {
      return viewer.scene.pick(click.position);
    },
    onClick(callback) {
      const handler = screenSpaceEventHandlerFactory(viewer);
      handler.setInputAction(callback, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      return () => handler.destroy();
    },
    replace(rows) {
      const nextEntities = [];
      for (const row of rows) {
        const color = Cesium.Color.fromCssColorString(colorOf(row));
        for (const [index, rings] of row.polygons.entries()) {
          const [outer, ...holes] = rings;
          const outerPositions = ringPositions(outer);
          nextEntities.push(
            new Cesium.Entity({
              id: `${idPrefix}:${row.stableId}:${index}`,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(
                  outerPositions,
                  holes.map(
                    (hole) => new Cesium.PolygonHierarchy(ringPositions(hole)),
                  ),
                ),
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(0.25),
                ),
              },
              // Ground-clamped outline (entity polygons cannot outline
              // clamped geometry themselves).
              polyline: {
                positions: outerPositions,
                clampToGround: true,
                width: 2,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(0.9),
                ),
              },
            }),
          );
        }
      }
      dataSource.entities.removeAll();
      for (const entity of nextEntities) dataSource.entities.add(entity);
    },
    destroy() {
      viewer.dataSources.remove(dataSource, true);
    },
  };
}
