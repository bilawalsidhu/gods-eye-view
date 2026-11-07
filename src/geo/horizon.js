/**
 * @module geo/horizon
 * @description Whether a point is beyond the WGS84 ellipsoid's horizon from
 * an eye, by the default renderer's own test (`EllipsoidalOccluder`), so
 * code that culls by it agrees with what the renderer culls.
 */
import { WGS84 } from './ellipsoid.js';

/**
 * A horizon test from `eye` (ECEF): `isPointVisible(p)` is false for a
 * point the ellipsoid hides from it.
 */
export function horizonFrom(eye) {
  const o = WGS84.oneOverRadii;
  const cx = eye.x * o.x;
  const cy = eye.y * o.y;
  const cz = eye.z * o.z;
  const limbSquared = cx * cx + cy * cy + cz * cz - 1;
  return {
    isPointVisible(p) {
      const tx = p.x * o.x - cx;
      const ty = p.y * o.y - cy;
      const tz = p.z * o.z - cz;
      const along = -(tx * cx + ty * cy + tz * cz);
      // Inside the ellipsoid the plane through the eye culls instead.
      const occluded =
        limbSquared < 0
          ? along > 0
          : along > limbSquared &&
            (along * along) / (tx * tx + ty * ty + tz * tz) > limbSquared;
      return !occluded;
    },
  };
}
