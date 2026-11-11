import { shadowFrame } from './besselian.js';

const FLATTENING = 1 / 298.257223563;
const POLAR_SQ = (1 - FLATTENING) ** 2;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The share of the Sun's disc (radius 1) hidden by a disc of radius `ratio`
 * whose centre is `distance` away: the area the two circles share.
 */
export function coveredShare(ratio, distance) {
  if (distance >= 1 + ratio) return 0;
  if (distance <= Math.abs(1 - ratio)) return Math.min(1, ratio * ratio);
  const a = Math.acos(
    (distance * distance + 1 - ratio * ratio) / (2 * distance),
  );
  const b = Math.acos(
    (distance * distance + ratio * ratio - 1) / (2 * distance * ratio),
  );
  const lens =
    a +
    ratio * ratio * b -
    0.5 *
      Math.sqrt(
        (1 + ratio - distance) *
          (distance + 1 - ratio) *
          (distance - 1 + ratio) *
          (distance + 1 + ratio),
      );
  return lens / Math.PI;
}

/**
 * The Sun and Moon as someone standing at Earth-fixed `point` (radii) sees
 * them at `ms`, with the zenith up. Lengths are in Sun radii: `moonRadius`
 * is the Moon's disc, `moonX` (right) and `moonY` (up) its centre from the
 * Sun's. `covered` is the share of the Sun's disc hidden, `phase` one of
 * `none`, `partial`, `annular`, `total`, and `sunAltitude` is in degrees.
 */
export function skyViewAt(eclipse, ms, point) {
  const frame = shadowFrame(eclipse, ms);
  const zeta = dot(point, frame.k);
  const r = [
    point[0] - frame.origin[0],
    point[1] - frame.origin[1],
    point[2] - frame.origin[2],
  ];
  const penumbra = frame.l1 - zeta * frame.tanF1;
  const umbra = frame.l2 - zeta * frame.tanF2;
  const sun = (penumbra + umbra) / 2;
  const moonRadius = (penumbra - umbra) / (penumbra + umbra);
  // Facing the Sun with north up, east is to the left: someone east of the
  // shadow axis sees the Moon west of the Sun, on their right.
  let x = dot(r, frame.i) / sun;
  let y = -dot(r, frame.j) / sun;
  // Turn the picture so the zenith, not celestial north, is up.
  const up = [point[0], point[1], point[2] / POLAR_SQ];
  const length = Math.hypot(up[0], up[1], up[2]);
  const zenithX = -dot(up, frame.i);
  const zenithY = dot(up, frame.j);
  const turn = Math.atan2(zenithX, zenithY);
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  [x, y] = [x * cos - y * sin, x * sin + y * cos];
  const distance = Math.hypot(x, y);
  const phase =
    distance >= 1 + moonRadius
      ? 'none'
      : distance <= Math.abs(1 - moonRadius)
        ? moonRadius >= 1
          ? 'total'
          : 'annular'
        : 'partial';
  return {
    moonRadius,
    moonX: x,
    moonY: y,
    distance,
    covered: coveredShare(moonRadius, distance),
    phase,
    sunAltitude:
      (Math.asin(Math.max(-1, Math.min(1, dot(up, frame.k) / length))) * 180) /
      Math.PI,
  };
}
