import { toRadians } from '../geo/index.js';
import { findCamera } from '../render/rendererOf.js';

/** The camera port's pose, or null when there is none to read. */
function poseOf(viewer) {
  try {
    return findCamera(viewer)?.pose() ?? null;
  } catch {
    return null;
  }
}

/** Camera range with breathing room in both viewport dimensions. */
export function rangeForBoundingSphere(viewer, radius) {
  const pose = poseOf(viewer);
  const fovy = Number(pose?.fovy);
  const aspect = Number(pose?.aspectRatio);
  // The frustum's field of view: along its wider side.
  const fov =
    fovy > 0 && aspect > 1
      ? 2 * Math.atan(Math.tan(fovy / 2) * aspect)
      : fovy > 0
        ? fovy
        : NaN;
  const verticalFov = fov || toRadians(60);
  const aspectRatio = Math.max(0.5, aspect || 1);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspectRatio);
  const limitingFov = Math.min(verticalFov, horizontalFov);
  // Target 57% sphere occupancy so perspective still leaves at least 40%
  // measured roof-to-base breathing room in ordinary oblique building views.
  const occupiedViewportFraction = 0.57;
  const desiredAngularRadius = (limitingFov * occupiedViewportFraction) / 2;
  return (radius / Math.sin(desiredAngularRadius)) * 1.05;
}
