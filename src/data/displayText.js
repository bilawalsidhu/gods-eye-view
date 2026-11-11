/** One-line text capped at `maxLength` without splitting a surrogate pair. Still untrusted. */
export function normalizeDisplayText(value, maxLength = 180) {
  if (value == null || typeof value === 'object') return '';
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim();
}
