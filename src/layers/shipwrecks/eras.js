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
