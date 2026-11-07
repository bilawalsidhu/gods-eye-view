/**
 * @module geo/polyline
 * @description Where a fraction of a polyline's length falls, measured
 * straight between its ECEF positions: what a line's `revealFraction`
 * draws up to.
 */

const span = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** Each segment's length, and their sum. */
function segmentLengths(positions) {
  const lengths = [];
  let total = 0;
  for (let i = 0; i + 1 < positions.length; i++) {
    lengths.push(span(positions[i], positions[i + 1]));
    total += lengths[i];
  }
  return { lengths, total };
}

/**
 * The segment a fraction of the polyline's length ends on, and how far
 * along it (`t`, 0..1): fractions past 0 and up to 1 only. Null when there
 * is no length to measure, or the fraction is outside `(0, 1]`.
 * @param {ReadonlyArray<{x: number, y: number, z: number}>} positions
 * @param {number} fraction
 * @returns {{index: number, t: number} | null}
 */
export function alongLength(positions, fraction) {
  if (!(fraction > 0) || fraction > 1 || positions.length < 2) return null;
  const { lengths, total } = segmentLengths(positions);
  if (!(total > 0)) return null;
  let left = fraction * total;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i])
      return { index: i, t: lengths[i] > 0 ? left / lengths[i] : 0 };
    left -= lengths[i];
  }
  return { index: lengths.length - 1, t: 1 };
}

/**
 * The fraction of the polyline's length that ends `t` (0..1) along segment
 * `index`: `alongLength` the other way round. Zero when there is no length.
 * @param {ReadonlyArray<{x: number, y: number, z: number}>} positions
 * @param {number} index
 * @param {number} t
 * @returns {number}
 */
export function lengthFraction(positions, index, t) {
  const { lengths, total } = segmentLengths(positions);
  if (!(total > 0)) return 0;
  let drawn = 0;
  for (let i = 0; i < lengths.length && i <= index; i++)
    drawn += i < index ? lengths[i] : lengths[i] * t;
  return drawn / total;
}
