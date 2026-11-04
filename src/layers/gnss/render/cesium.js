import * as Cesium from 'cesium';
import { GNSS_LEVEL_COLORS } from '../records.js';

/** Degrees at the centre of the current view, or null before the camera settles. */
export function defaultGnssViewAnchor(viewer) {
  const canvas = viewer?.scene?.canvas;
  const ellipsoid = viewer?.scene?.globe?.ellipsoid;
  // At globe scale the visible rectangle can be the whole world, whose
  // midpoint is unrelated to the place under the screen centre.
  const centre =
    canvas?.clientWidth > 0 &&
    canvas.clientHeight > 0 &&
    viewer.camera?.pickEllipsoid?.(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      ellipsoid,
    );
  const rectangle =
    !centre && viewer?.camera?.computeViewRectangle?.(ellipsoid);
  const carto = centre
    ? (ellipsoid || Cesium.Ellipsoid.WGS84).cartesianToCartographic(centre)
    : rectangle
      ? Cesium.Rectangle.center(rectangle)
      : viewer?.camera?.positionCartographic;
  if (!carto) return null;
  const latitude = Cesium.Math.toDegrees(carto.latitude);
  const longitude = Cesium.Math.toDegrees(carto.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

export function createGnssCesiumRenderer({
  viewer,
  viewAnchor = defaultGnssViewAnchor,
}) {
  // GroundPrimitive allowPicking:false still submits stencil commands in
  // the pick pass. Keep this fill from erasing overlapping geometry's picks.
  class GnssGroundFill extends Cesium.GroundPrimitive {
    update(frameState) {
      if (!frameState.passes.pick) super.update(frameState);
    }
  }

  const primitives = new Cesium.PrimitiveCollection();
  primitives.id = 'gnss-integrity';
  primitives.show = false;
  viewer.scene.groundPrimitives.add(primitives);
  return {
    camera: viewer.camera,
    anchor: () => viewAnchor(viewer),
    setVisible(show) {
      primitives.show = show;
    },
    replace(cells, alpha) {
      primitives.removeAll();
      if (cells.length) {
        primitives.add(
          new GnssGroundFill({
            geometryInstances: cells.map(
              (cell) =>
                new Cesium.GeometryInstance({
                  id: `gnss-integrity:${cell.id}`,
                  geometry: new Cesium.RectangleGeometry({
                    rectangle: Cesium.Rectangle.fromDegrees(
                      cell.west,
                      cell.south,
                      cell.east,
                      cell.north,
                    ),
                    vertexFormat:
                      Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                  }),
                  attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                      Cesium.Color.fromCssColorString(
                        GNSS_LEVEL_COLORS[cell.level],
                      ).withAlpha(alpha[cell.level]),
                    ),
                  },
                }),
            ),
            appearance: new Cesium.PerInstanceColorAppearance({
              flat: true,
              translucent: true,
            }),
            classificationType: Cesium.ClassificationType.BOTH,
            allowPicking: false,
            // Retain the compact rectangle descriptors for inspection, not Entity visualizers.
            releaseGeometryInstances: false,
          }),
        );
      }
      viewer?.scene?.requestRender?.();
    },
    destroy() {
      viewer.scene.groundPrimitives.remove(primitives);
    },
  };
}
