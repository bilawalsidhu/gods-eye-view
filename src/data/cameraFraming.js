import * as Cesium from 'cesium';

/** Camera range with breathing room in both viewport dimensions. */
export function rangeForBoundingSphere(viewer, radius) {
  const frustum = viewer.camera?.frustum;
  const verticalFov = Number(frustum?.fov) || Cesium.Math.toRadians(60);
  const aspectRatio = Math.max(0.5, Number(frustum?.aspectRatio) || 1);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspectRatio);
  const limitingFov = Math.min(verticalFov, horizontalFov);
  // Target 57% sphere occupancy so perspective still leaves at least 40%
  // measured roof-to-base breathing room in ordinary oblique building views.
  const occupiedViewportFraction = 0.57;
  const desiredAngularRadius = (limitingFov * occupiedViewportFraction) / 2;
  return (radius / Math.sin(desiredAngularRadius)) * 1.05;
}
