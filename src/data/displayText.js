/** Bounded, single-line external display text; it remains untrusted source data. */
export function normalizeDisplayText(value, maxLength = 180) {
  if (value == null || typeof value === 'object' || typeof value === 'function')
    return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim();
}
