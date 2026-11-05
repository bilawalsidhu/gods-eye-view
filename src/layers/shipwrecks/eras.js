/** Era chips, oldest first; a wreck with no known year sits in its own chip. */
export const SHIPWRECK_ERAS = Object.freeze([
  'before-1900',
  '1900-1945',
  'after-1945',
  'undated',
]);

/**
 * The era a wreck belongs to. Ancient wrecks dated only by period
 * ("Roman Imperial", "C1st AD") count as before 1900.
 * @param {{year?: number|null, ancient?: boolean}} record
 * @returns {string}
 */
export function eraOf(record) {
  const year = Number.isInteger(record?.year) ? record.year : null;
  if (year === null) return record?.ancient ? 'before-1900' : 'undated';
  if (year < 1900) return 'before-1900';
  if (year <= 1945) return '1900-1945';
  return 'after-1945';
}

/**
 * Normalize a requested set of eras; unknown names are ignored and an empty
 * or missing request keeps the current set.
 * @param {unknown} value Array of era ids.
 * @param {Set<string>} current
 * @returns {Set<string>}
 */
export function normalizeEras(value, current) {
  if (!Array.isArray(value)) return new Set(current);
  return new Set(value.filter((era) => SHIPWRECK_ERAS.includes(era)));
}
