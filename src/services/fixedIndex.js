/**
 * Values at or past this many degrees are left to `toFixed`. At most 500:
 * terrainHeights packs two 5-decimal indices below it as `lat * 1e8 + lon`,
 * and past 500 two coordinates can pack to one key.
 */
export const FIXED_INDEX_LIMIT_DEG = 500;

/**
 * `Number(value.toFixed(digits)) * 10 ** digits` as an integer, for digits up
 * to 5. `toFixed` rounds the exact decimal value, and `value * 10 ** digits`
 * is within 1e-8 of it below FIXED_INDEX_LIMIT_DEG, so the arithmetic is used
 * everywhere except right at a half and at or past the limit, where the value
 * is formatted. A small negative value gives -0.
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
export function fixedIndex(value, digits) {
  const scale = 10 ** digits;
  const scaled = value * scale;
  const index = Math.round(scaled);
  if (
    Math.abs(scaled - Math.floor(scaled) - 0.5) < 1e-6 ||
    !(Math.abs(index) < FIXED_INDEX_LIMIT_DEG * scale)
  )
    return Math.round(Number(value.toFixed(digits)) * scale);
  return index;
}
