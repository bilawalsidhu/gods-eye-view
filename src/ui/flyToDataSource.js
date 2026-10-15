/** Frame the complete finite footprint of a session-local file. */
import * as Cesium from 'cesium';
import { guardCameraAboveGround } from '../cameraGroundGuard.js';
import { rangeForBoundingSphere } from '../data/cameraFraming.js';
import { cancelCameraArrival } from '../data/cameraArrival.js';

/** All visible positions, path vertices, polygon rings, walls and overlay bounds. */
export function dataSourcePoints(dataSource, time = Cesium.JulianDate.now()) {
  const points = [];
  const add = (position, grounded = false) => {
    if (
      !position ||
      ![position.x, position.y, position.z].every(Number.isFinite)
    )
      return;
    const c = Cesium.Cartographic.fromCartesian(position);
    if (c && Number.isFinite(c.longitude) && Number.isFinite(c.latitude))
      points.push([
        Cesium.Math.toDegrees(c.longitude),
        Cesium.Math.toDegrees(c.latitude),
        grounded ? 0 : c.height,
      ]);
  };
  if (dataSource?.show === false) return points;
  for (const entity of dataSource?.importedEntities ??
    dataSource?.entities?.values ??
    []) {
    if (entity.isShowing === false) continue;
    add(
      entity.position?.getValue?.(time),
      entity.billboard?.heightReference?.getValue?.(time) ===
        Cesium.HeightReference.CLAMP_TO_GROUND,
    );
    for (const graphic of [entity.polyline, entity.wall])
      for (const position of graphic?.positions?.getValue?.(time) || [])
        add(position, graphic.clampToGround?.getValue?.(time) === true);
    const rings = [entity.polygon?.hierarchy?.getValue?.(time)];
    while (rings.length) {
      const ring = rings.pop();
      for (const position of ring?.positions || [])
        add(
          position,
          entity.polygon?.perPositionHeight?.getValue?.(time) !== true,
        );
      for (const hole of ring?.holes || []) rings.push(hole);
    }
    const rectangle = entity.rectangle?.coordinates?.getValue?.(time);
    if (rectangle) {
      const bounds = Cesium.RectangleGeometry.computeRectangle({
        rectangle,
        rotation: entity.rectangle.rotation?.getValue?.(time) || 0,
      });
      for (const corner of [
        'southwest',
        'southeast',
        'northwest',
        'northeast',
      ]) {
        const c = Cesium.Rectangle[corner](bounds);
        if (Number.isFinite(c.longitude) && Number.isFinite(c.latitude))
          points.push([
            Cesium.Math.toDegrees(c.longitude),
            Cesium.Math.toDegrees(c.latitude),
            entity.rectangle.height?.getValue?.(time) || 0,
          ]);
      }
    }
  }
  return points;
}

/** Fly synchronously to the footprint; later navigation always owns its camera. */
export function flyToDataSource(
  viewer,
  dataSource,
  { duration = 1.5, ground = null } = {},
) {
  const points = dataSourcePoints(dataSource);
  if (!points.length) return false;
  cancelCameraArrival(viewer);
  const positions = points.map(([lon, lat, height]) =>
    Cesium.Cartesian3.fromDegrees(lon, lat, height),
  );
  const sphere = Cesium.BoundingSphere.fromPoints(positions);
  const center =
    Cesium.Cartographic.fromCartesian(sphere.center) ||
    Cesium.Cartographic.fromDegrees(points[0][0], points[0][1]);
  const lat = Cesium.Math.toDegrees(center.latitude),
    lon = Cesium.Math.toDegrees(center.longitude);
  const terrain = viewer.scene?.globe?.getHeight?.(center);
  const cached = ground?.cachedGroundFloor?.(lat, lon);
  const height =
    Number.isFinite(terrain) && terrain > 0
      ? terrain
      : Number.isFinite(cached)
        ? cached
        : Number.isFinite(terrain)
          ? terrain
          : 0;
  ground?.warmGroundFloor?.([{ lat, lon }]);
  sphere.center = Cesium.Cartesian3.fromRadians(
    center.longitude,
    center.latitude,
    Math.max(0, height, center.height),
  );
  sphere.radius = 0;
  for (const position of positions)
    sphere.radius = Math.max(
      sphere.radius,
      Cesium.Cartesian3.distance(sphere.center, position),
    );
  viewer.camera?.flyToBoundingSphere?.(sphere, {
    offset: new Cesium.HeadingPitchRange(
      viewer.camera.heading || 0,
      -Math.PI / 2,
      Math.max(800, rangeForBoundingSphere(viewer, sphere.radius)),
    ),
    duration,
    complete: () => guardCameraAboveGround(viewer, { lat, lon }),
  });
  return true;
}
