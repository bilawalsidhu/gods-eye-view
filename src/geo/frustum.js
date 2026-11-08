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

/**
 * Canvas coordinates (CSS px, origin top left) of world points on a `width`
 * by `height` canvas, as the default renderer projects them from `pose`
 * (its frustum's projection matrix times its view matrix, centred, no
 * offset): one pose read for many points, rather than a renderer call per
 * point. Null behind the eye and before the projection's clip plane at
 * `2·far·near / (far + near)` (a little past `near`; `2·near` with no far
 * plane), where the renderer's own projection answers nothing.
 * @param {{position: object, direction: object, up: object, fovy: number,
 *   aspectRatio: number, near: number, far: number}} pose
 * @param {number} width
 * @param {number} height
 * @param {{x: number, y: number}} [out] Written and returned by every call.
 * @returns {(p: {x: number, y: number, z: number}) =>
 *   ({x: number, y: number}|null)}
 */
export function poseProjector(pose, width, height, out = { x: 0, y: 0 }) {
  const { position: e, direction: d, up: u, near, far } = pose;
  const r = cross(d, u);
  const tanY = Math.tan(0.5 * pose.fovy);
  const tanX = pose.aspectRatio * tanY;
  // With no far plane the clip plane is at twice `near`, its limit.
  const clipDepth = Number.isFinite(far)
    ? (2 * far * near) / (far + near)
    : 2 * near;
  return (p) => {
    const vx = p.x - e.x;
    const vy = p.y - e.y;
    const vz = p.z - e.z;
    const depth = vx * d.x + vy * d.y + vz * d.z;
    if (!(depth > 0) || depth < clipDepth) return null;
    const x = (vx * r.x + vy * r.y + vz * r.z) / (depth * tanX);
    const y = (vx * u.x + vy * u.y + vz * u.z) / (depth * tanY);
    out.x = (x + 1) * 0.5 * width;
    out.y = (1 - y) * 0.5 * height;
    return out;
  };
}
