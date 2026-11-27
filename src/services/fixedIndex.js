/** Values at or past this many degrees are left to `toFixed`. */
export const FIXED_INDEX_LIMIT_DEG = 500;

/**
 * `Number(value.toFixed(digits)) * scale` as an integer, with
 * `scale = 10 ** digits` up to 1e5, without formatting a string; null where
 * the arithmetic cannot be trusted to match `toFixed`. `toFixed` rounds the
 * exact decimal value, and `value * scale` is within 1e-8 of it below
 * FIXED_INDEX_LIMIT_DEG, so the two can differ only right at a half. A small
 * negative value gives -0.
 * @param {number} value
 * @param {number} scale
 * @returns {number|null}
 */
export function fixedIndex(value, scale) {
  const scaled = value * scale;
  if (Math.abs(scaled - Math.floor(scaled) - 0.5) < 1e-6) return null;
  const index = Math.round(scaled);
  return Math.abs(index) < FIXED_INDEX_LIMIT_DEG * scale ? index : null;
}
