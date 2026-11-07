/** Frame the complete finite footprint of a session-local file. */
import { guardCameraAboveGround } from '../cameraGroundGuard.js';
import { rangeForBoundingSphere } from '../data/cameraFraming.js';
import { cancelCameraArrival } from '../data/cameraArrival.js';
import { distance, fromDegrees, toLonLatH } from '../geo/index.js';
import { sphereFromPoints } from '../geo/sphere.js';
import { heightsOf } from '../queries/heights.js';
import { findCamera } from '../render/rendererOf.js';

/**
 * Fly synchronously to a footprint, `[lon, lat, height]` points (degrees,
 * metres) such as a file's (`dataSourcePoints`); later navigation always
 * owns its camera. False when there is nothing to frame or no camera.
 */
export function flyToFootprint(
  viewer,
  points,
  { duration = 1.5, ground = null } = {},
) {
  if (!points?.length) return false;
  const camera = findCamera(viewer);
  if (!camera) return false;
  cancelCameraArrival(viewer);
  const positions = points.map(([lon, lat, height]) =>
    fromDegrees(lon, lat, height),
  );
  const sphere = sphereFromPoints(positions);
  const center = toLonLatH(sphere.center) || {
    lon: points[0][0],
    lat: points[0][1],
    height: 0,
  };
  const { lat, lon } = center;
  const terrain = viewer
    ? heightsOf(viewer).now({ lon, lat }, { against: 'terrain' })
    : null;
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
  const framed = {
    center: fromDegrees(lon, lat, Math.max(0, height, center.height)),
    radius: 0,
  };
  for (const position of positions)
    framed.radius = Math.max(framed.radius, distance(framed.center, position));
  camera.flyToBounds(framed, {
    offset: {
      heading: camera.pose().heading || 0,
      pitch: -Math.PI / 2,
      range: Math.max(800, rangeForBoundingSphere(viewer, framed.radius)),
    },
    durationS: duration,
    onComplete: () => guardCameraAboveGround(viewer, { lat, lon }),
  });
  return true;
}
