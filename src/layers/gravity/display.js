/** Presentation shared by the layer and its rail card; no Cesium here. */

/**
 * Centimetres of equivalent water against colour, red for loss and blue for
 * gain (ColorBrewer RdBu). Values past the ends take the end colour: the
 * largest signals (Greenland and Antarctic ice loss) run to metres, and a
 * scale stretched to fit them would leave every aquifer the same pale tint.
 * Near zero fades out so the map underneath stays readable.
 */
export const GRAVITY_COLORS = Object.freeze([
  [-40, [103, 0, 31, 225]],
  [-20, [214, 96, 77, 205]],
  [-8, [244, 165, 130, 175]],
  [-2, [253, 219, 199, 70]],
  [0, [247, 247, 247, 0]],
  [2, [209, 229, 240, 70]],
  [8, [146, 197, 222, 175]],
  [20, [67, 147, 195, 205]],
  [40, [5, 48, 97, 225]],
]);

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
