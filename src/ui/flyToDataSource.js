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

/**
 * Longitude/latitude pairs of every entity's position, line and polygon,
 * thinned to at most `MAX_POINTS`. Long tracks are walked by index, never
 * spread into a call, so a file with hundreds of thousands of vertices cannot
 * overflow the stack; only the kept points are converted.
 */
export function dataSourcePoints(dataSource, time = Cesium.JulianDate.now()) {
  const parts = [];
  let total = 0;
  for (const entity of dataSource?.entities?.values ?? []) {
    const at = entity.position?.getValue?.(time);
    if (at) {
      parts.push([at]);
      total += 1;
    }
    const line = entity.polyline?.positions?.getValue?.(time);
    if (Array.isArray(line) && line.length) {
      parts.push(line);
      total += line.length;
    }
    const ring = entity.polygon?.hierarchy?.getValue?.(time)?.positions;
    if (Array.isArray(ring) && ring.length) {
      parts.push(ring);
      total += ring.length;
    }
  }
  const stride = Math.max(1, Math.ceil(total / MAX_POINTS));
  const points = [];
  let index = 0;
  for (const part of parts) {
    // Keep every stride-th vertex across all parts, plus each part's ends so
    // a short line is never skipped entirely.
    for (let i = 0; i < part.length; i++, index++) {
      if (index % stride !== 0 && i !== 0 && i !== part.length - 1) continue;
      const carto = Cesium.Cartographic.fromCartesian(part[i]);
      if (!carto) continue;
      points.push([
        Cesium.Math.toDegrees(carto.longitude),
        Cesium.Math.toDegrees(carto.latitude),
      ]);
    }
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
