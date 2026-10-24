/** Presentation shared by the layer and its rail card; no Cesium here. */

/**
 * Centimetres of equivalent water against colour, red for loss and blue for
 * gain (ColorBrewer RdBu). Within ±40 cm the scale is unchanged, so aquifers
 * and lakes keep their contrast. Past that it keeps deepening to ±400 cm
 * instead of stopping: the largest signals (Greenland, Alaska and Antarctic
 * ice loss) run to metres, and a hard stop at 40 drew them as flat patches.
 * Only the cores of the ice sheets pass 400 and take the end colour. Near
 * zero fades out so the map underneath stays readable.
 */
export const GRAVITY_COLORS = Object.freeze([
  [-400, [38, 0, 14, 240]],
  [-100, [72, 0, 22, 232]],
  [-40, [103, 0, 31, 225]],
  [-20, [214, 96, 77, 205]],
  [-8, [244, 165, 130, 175]],
  [-2, [253, 219, 199, 70]],
  [0, [247, 247, 247, 0]],
  [2, [209, 229, 240, 70]],
  [8, [146, 197, 222, 175]],
  [20, [67, 147, 195, 205]],
  [40, [5, 48, 97, 225]],
  [100, [3, 30, 68, 232]],
  [400, [0, 14, 38, 240]],
]);

/** The ±40 cm core of the legend; it takes the middle 60% of the ramp. */
export const GRAVITY_CORE_CM = 40;
const CORE_SHARE = 0.6;
const END_CM = GRAVITY_COLORS.at(-1)[0];

/**
 * Where a value sits on the legend ramp, 0 to 1. The core is linear; each
 * tail from 40 to 400 cm is logarithmic and takes 20% of the ramp, so the
 * metres of ice loss fit without squeezing the range most of the map uses.
 */
export function gravityScalePosition(cm) {
  const magnitude = Math.min(Math.abs(cm), END_CM);
  const half =
    magnitude <= GRAVITY_CORE_CM
      ? (magnitude / GRAVITY_CORE_CM) * CORE_SHARE
      : CORE_SHARE +
        ((1 - CORE_SHARE) * Math.log(magnitude / GRAVITY_CORE_CM)) /
          Math.log(END_CM / GRAVITY_CORE_CM);
  return 0.5 + (Math.sign(cm) * half) / 2;
}

/** "2026-07-01" -> "Jul 2026", in UTC and the page's language. */
export function gravityMonthLabel(day) {
  if (!day) return '';
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export const formatGravityCm = (cm) =>
  `${cm > 0 ? '+' : cm < 0 ? '−' : ''}${Math.abs(cm).toFixed(1)} cm`;
