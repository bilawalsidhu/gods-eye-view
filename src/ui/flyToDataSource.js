/**
 * Fly to everything in a data source (an imported file, a live feed) without
 * trusting Cesium's own framing of ground-clamped points: before the
 * destination's terrain has streamed in, a clamped billboard reports a
 * bounding sphere kilometers below the surface, and `viewer.flyTo` follows it
 * underground. Instead the footprint is framed from the features' longitudes
 * and latitudes, and the camera ground guard lifts the eye once the real
 * surface can be measured.
 */
import * as Cesium from 'cesium';
import { guardCameraAboveGround } from '../cameraGroundGuard.js';

const MAX_POINTS = 5000;

/** Longitude/latitude pairs of every entity's position, line and polygon. */
export function dataSourcePoints(dataSource, time = Cesium.JulianDate.now()) {
  const cartesians = [];
  for (const entity of dataSource?.entities?.values ?? []) {
    const at = entity.position?.getValue?.(time);
    if (at) cartesians.push(at);
    const line = entity.polyline?.positions?.getValue?.(time);
    if (Array.isArray(line)) cartesians.push(...line);
    const hierarchy = entity.polygon?.hierarchy?.getValue?.(time);
    if (Array.isArray(hierarchy?.positions))
      cartesians.push(...hierarchy.positions);
  }
  const stride = Math.max(1, Math.ceil(cartesians.length / MAX_POINTS));
  const points = [];
  for (let i = 0; i < cartesians.length; i += stride) {
    const carto = Cesium.Cartographic.fromCartesian(cartesians[i]);
    if (!carto) continue;
    points.push([
      Cesium.Math.toDegrees(carto.longitude),
      Cesium.Math.toDegrees(carto.latitude),
    ]);
  }
  return points;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {Cesium.DataSource} dataSource
 * @param {{duration?: number}} [options]
 * @returns {boolean} Whether there was anything to fly to.
 */
export function flyToDataSource(viewer, dataSource, { duration = 1.5 } = {}) {
  const points = dataSourcePoints(dataSource);
  if (!points.length) {
    viewer.flyTo?.(dataSource, { duration });
    return false;
  }
  const sphere = Cesium.BoundingSphere.fromPoints(
    points.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, 0)),
  );
  const center = Cesium.Cartographic.fromCartesian(sphere.center);
  viewer.camera?.flyToBoundingSphere?.(sphere, {
    offset: new Cesium.HeadingPitchRange(
      viewer.camera.heading || 0,
      Cesium.Math.toRadians(-45),
      Math.max(800, sphere.radius * 2.8),
    ),
    duration,
    complete: () =>
      guardCameraAboveGround(viewer, {
        lat: Cesium.Math.toDegrees(center.latitude),
        lon: Cesium.Math.toDegrees(center.longitude),
      }),
  });
  return true;
}
