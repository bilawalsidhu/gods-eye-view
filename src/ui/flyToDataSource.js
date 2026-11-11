/** Frame the complete finite footprint of a session-local file. */
import * as geo from '../geo/index.js';
import { fromPoints } from '../geo/boundingSphere.js';
import { guardCameraAboveGround } from '../cameraGroundGuard.js';
import { rangeForBoundingSphere } from '../data/cameraFraming.js';
import { cancelCameraArrival } from '../data/cameraArrival.js';

/**
 * Fly synchronously to a footprint: `points` as [lon, lat, height]
 * (src/data/geoImportRecords.js recordFootprint), straight down at the
 * ground under its centre; later navigation always owns its camera.
 * `engine` is the globe engine (Cesium or Navara), which flies the sphere
 * through the contract's flyToSphere. False for an empty footprint.
 */
export function flyToFootprint(
  engine,
  points,
  { duration = 1.5, ground = null } = {},
) {
  const finite = (points ?? []).filter(
    ([lon, lat, height = 0]) =>
      Number.isFinite(lon) && Number.isFinite(lat) && Number.isFinite(height),
  );
  if (!finite.length) return false;
  cancelCameraArrival(engine);
  const positions = finite.map(([lon, lat, height = 0]) =>
    geo.cartesian3.fromDegrees(lon, lat, height),
  );
  const sphere = fromPoints(positions);
  const center =
    geo.cartographic.fromCartesian(sphere.center) ||
    geo.cartographic.fromDegrees(finite[0][0], finite[0][1], 0);
  const lat = geo.math.toDegrees(center.latitude),
    lon = geo.math.toDegrees(center.longitude);
  const terrain = engine.surface.terrainHeightSupported
    ? engine.surface.terrainHeight(center)
    : undefined;
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
  sphere.center = geo.cartesian3.fromRadians(
    center.longitude,
    center.latitude,
    Math.max(0, height, center.height),
  );
  sphere.radius = 0;
  for (const position of positions)
    sphere.radius = Math.max(
      sphere.radius,
      geo.cartesian3.distance(sphere.center, position),
    );
  const pose = engine.camera.pose();
  const aspect = pose.aspectRatio ?? 1;
  // Cesium's frustum fov: the wider side's angle.
  const fov =
    aspect > 1 ? 2 * Math.atan(Math.tan(pose.fovy / 2) * aspect) : pose.fovy;
  engine.camera.flyToSphere(
    { center: sphere.center, radius: sphere.radius },
    {
      heading: pose.heading || 0,
      pitch: -Math.PI / 2,
      range: Math.max(
        800,
        rangeForBoundingSphere(
          { camera: { frustum: { fov, aspectRatio: aspect } } },
          sphere.radius,
        ),
      ),
      duration,
      complete: () => guardCameraAboveGround(engine, { lat, lon }),
    },
  );
  return true;
}
