import * as Cesium from 'cesium';
import { mllwEllipsoidHeight } from './model.js';

/**
 * One animated water sheet over a station's stretch of coast.
 *
 * The sheet is tessellated once at the station's MLLW ellipsoid height and
 * moved up and down with a model matrix, so scrubbing time never rebuilds
 * geometry. Depth testing against terrain and 3D Tiles hides it wherever the
 * ground is higher than the water — which is the whole effect: the shoreline
 * you see is where the photogrammetry meets the tide.
 */
export function createWaterSurface(scene, station) {
  const base = mllwEllipsoidHeight(station);
  const rectangle = Cesium.Rectangle.fromDegrees(
    station.lon - station.box.lon,
    station.lat - station.box.lat,
    station.lon + station.box.lon,
    station.lat + station.box.lat,
  );
  const center = Cesium.Cartesian3.fromDegrees(station.lon, station.lat, base);
  const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
    center,
    new Cesium.Cartesian3(),
  );
  const offset = new Cesium.Cartesian3();
  const modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);

  const material = Cesium.Material.fromType('Water', {
    baseWaterColor: new Cesium.Color(0.09, 0.36, 0.45, 0.62),
    blendColor: new Cesium.Color(0.12, 0.5, 0.56, 0.55),
    normalMap: Cesium.buildModuleUrl('Assets/Textures/waterNormals.jpg'),
    frequency: 1800,
    animationSpeed: 0.012,
    amplitude: 4,
    specularIntensity: 0.45,
  });

  const primitive = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      id: `coastal-tides:${station.id}`,
      geometry: new Cesium.RectangleGeometry({
        rectangle,
        height: base,
        granularity: Cesium.Math.toRadians(0.002),
        vertexFormat: Cesium.EllipsoidSurfaceAppearance.VERTEX_FORMAT,
      }),
    }),
    appearance: new Cesium.EllipsoidSurfaceAppearance({
      material,
      aboveGround: false,
      translucent: true,
    }),
    modelMatrix,
    asynchronous: false,
    allowPicking: false,
  });
  scene.primitives.add(primitive);

  return {
    station,
    /** Raise or lower the sheet to an absolute ellipsoid height (metres). */
    setHeight(ellipsoidHeight) {
      const delta = ellipsoidHeight - base;
      Cesium.Cartesian3.multiplyByScalar(up, delta, offset);
      Cesium.Matrix4.fromTranslation(offset, modelMatrix);
      primitive.modelMatrix = modelMatrix;
    },
    setShow(show) {
      primitive.show = Boolean(show);
    },
    destroy() {
      if (!primitive.isDestroyed()) scene.primitives.remove(primitive);
    },
  };
}
