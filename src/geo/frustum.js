/**
 * @module geo/frustum
 * @description The view frustum of a camera pose as the default renderer
 * culls with it (`PerspectiveFrustum.computeCullingVolume` and
 * `CullingVolume.computeVisibility`, centred, no offset), so code that culls
 * by what is on screen agrees with what the renderer draws. No engine.
 */
import { add, cross, dot, normalize, scale, sub } from './vector.js';

/**
 * The six planes (`{normal, w}`, inside where `normal · p + w ≥ 0`) of the
 * frustum `pose` looks through: a camera port pose's `position`,
 * `direction`, `up`, `fovy`, `aspectRatio`, `near` and `far`.
 * @param {{position: object, direction: object, up: object, fovy: number,
 *   aspectRatio: number, near: number, far: number}} pose
 * @returns {Array<{normal: {x: number, y: number, z: number}, w: number}>}
 */
export function frustumPlanes(pose) {
  const { position, direction, up, near, far } = pose;
  const t = near * Math.tan(0.5 * pose.fovy);
  const b = -t;
  const r = pose.aspectRatio * t;
  const l = -r;

  const right = cross(direction, up);
  const nearCenter = add(position, scale(direction, near));
  const farCenter = add(position, scale(direction, far));
  const plane = (normal) => ({ normal, w: -dot(normal, position) });

  const left = plane(
    normalize(
      cross(normalize(sub(add(nearCenter, scale(right, l)), position)), up),
    ),
  );
  const rightPlane = plane(
    normalize(cross(up, sub(add(nearCenter, scale(right, r)), position))),
  );
  const bottom = plane(
    normalize(cross(right, sub(add(nearCenter, scale(up, b)), position))),
  );
  const top = plane(
    normalize(cross(sub(add(nearCenter, scale(up, t)), position), right)),
  );
  const nearPlane = { normal: direction, w: -dot(direction, nearCenter) };
  const back = scale(direction, -1);
  const farPlane = { normal: back, w: -dot(back, farCenter) };
  return [left, rightPlane, bottom, top, nearPlane, farPlane];
}

/**
 * Whether a sphere is wholly outside `planes` (from `frustumPlanes`), as
 * the default renderer's `CullingVolume.computeVisibility` reports
 * `Intersect.OUTSIDE`.
 * @param {ReturnType<typeof frustumPlanes>} planes
 * @param {{x: number, y: number, z: number}} center
 * @param {number} radius
 */
export function sphereOutside(planes, center, radius) {
  for (const { normal, w } of planes)
    if (dot(normal, center) + w < -radius) return true;
  return false;
}
