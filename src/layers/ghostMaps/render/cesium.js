import * as Cesium from 'cesium';
import { createHorizonCull } from '../../streetLevel/view.js';

const cesiumColor = (rgba, fallback, alpha) =>
  rgba
    ? new Cesium.Color(rgba[0], rgba[1], rgba[2], alpha ?? rgba[3])
    : Cesium.Color.fromCssColorString(fallback).withAlpha(alpha ?? 1);

export function createGhostMapsCesiumRenderer(
  viewer,
  createHandler,
  markerImage,
) {
  const allPins = new Set();
  const horizon = createHorizonCull({
    getViewer: () => viewer,
    items: () => allPins,
    onChange: () => viewer.scene.requestRender?.(),
  });
  return {
    requestRender: () => viewer.scene.requestRender?.(),
    onClick(run) {
      const handler = createHandler(viewer);
      handler.setInputAction(
        (click) => run(click, () => viewer.scene.pick(click.position)),
        Cesium.ScreenSpaceEventType.LEFT_CLICK,
      );
      return () => handler.destroy();
    },
    draw(productId, features, color) {
      const dataSource = new Cesium.CustomDataSource(
        `s2-ghostmaps:${productId}`,
      );
      const pins = [];
      dataSource.entities.suspendEvents();
      features.forEach((feature, index) => {
        const key = `${productId}:${index}`;
        const { style } = feature;
        feature.geometries.forEach((geometry, part) => {
          const id = `ghostmaps:${key}:${part}`;
          if (geometry.type === 'point') {
            const position = Cesium.Cartesian3.fromDegrees(
              ...geometry.position,
            );
            const entity = dataSource.entities.add({
              id,
              position,
              billboard: {
                image: style.icon || markerImage(color),
                scale: Math.min(
                  1.5,
                  Math.max(0.35, (style.iconScale ?? 1) * 0.7),
                ),
                color:
                  style.icon && style.iconColor
                    ? cesiumColor(style.iconColor)
                    : undefined,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                verticalOrigin: Cesium.VerticalOrigin.CENTER,
                // Ground-clamped icons would sink into terrain and 3D tiles; the
                // horizon cull hides the far side instead (see `_horizon`).
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
            });
            pins.push({
              position,
              get show() {
                return entity.show;
              },
              set show(value) {
                entity.show = value;
              },
            });
          } else if (geometry.type === 'line') {
            dataSource.entities.add({
              id,
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray(
                  geometry.positions.flat(),
                ),
                width: Math.min(8, Math.max(1.5, style.lineWidth ?? 2)),
                material: cesiumColor(style.lineColor, color),
                clampToGround: true,
              },
            });
          } else {
            const ring = (points) =>
              Cesium.Cartesian3.fromDegreesArray(points.flat());
            dataSource.entities.add({
              id,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(
                  ring(geometry.outer),
                  geometry.holes.map(
                    (hole) => new Cesium.PolygonHierarchy(ring(hole)),
                  ),
                ),
                material:
                  style.fill === false
                    ? Cesium.Color.TRANSPARENT
                    : cesiumColor(
                        style.polyColor,
                        color,
                        style.polyColor ? undefined : 0.25,
                      ),
                classificationType: Cesium.ClassificationType.BOTH,
              },
            });
            if (style.outline !== false)
              dataSource.entities.add({
                id: `${id}:outline`,
                polyline: {
                  positions: ring([...geometry.outer, geometry.outer[0]]),
                  width: Math.min(6, Math.max(1.5, style.lineWidth ?? 2)),
                  material: cesiumColor(style.lineColor, color),
                  clampToGround: true,
                },
              });
          }
        });
      });
      dataSource.entities.resumeEvents();
      for (const pin of pins) allPins.add(pin);
      horizon.update(pins);
      let disposed = false;
      const ready = Promise.resolve(viewer.dataSources.add(dataSource)).finally(
        () => {
          if (disposed) viewer.dataSources.remove(dataSource, true);
        },
      );
      return {
        ready,
        destroy() {
          disposed = true;
          for (const pin of pins) allPins.delete(pin);
          viewer.dataSources.remove(dataSource, true);
        },
      };
    },
    destroy: horizon.stop,
  };
}
