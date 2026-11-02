import * as Cesium from 'cesium';
import { containmentAccent } from '../cards.js';
/** Fill/line color for a perimeter by containment progress (same ramp as the card accent). */
export function containmentColor(containedPct) {
  return Cesium.Color.fromCssColorString(containmentAccent(containedPct));
}

const ringPositions = (ring) =>
  ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));

export function createPerimetersCesiumRenderer({
  viewer,
  screenSpaceEventHandlerFactory,
}) {
  const dataSource = new Cesium.CustomDataSource('fire-perimeters');
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
        const color = containmentColor(row.containedPct);
        for (const [index, rings] of row.polygons.entries()) {
          const [outer, ...holes] = rings;
          const outerPositions = ringPositions(outer);
          nextEntities.push(
            new Cesium.Entity({
              id: `fire-perimeter:${row.stableId}:${index}`,
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
              // The fire line: ground-clamped outline (entity polygons cannot
              // outline clamped geometry themselves).
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
