/**
 * The few interpolation helpers the launch paths and cameras share, written
 * as the default renderer writes them so the paths land on the same points.
 */

/** `p` to `q` by `t`. */
export const lerp = (p, q, t) => (1.0 - t) * p + t * q;

/** ECEF `start` to `end` by `t`, as a new point. */
export const lerpPoint = (start, end, t) => ({
  x: end.x * t + start.x * (1.0 - t),
  y: end.y * t + start.y * (1.0 - t),
  z: end.z * t + start.z * (1.0 - t),
});

/** `m` modulo `n`, in `n`'s sign. */
export function mod(m, n) {
  if (Math.sign(m) === Math.sign(n) && Math.abs(m) < Math.abs(n)) return m;
  return ((m % n) + n) % n;
}
