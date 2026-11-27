// msg() and englishText() for modules the server, tools or other portable code
// also import: marks English that stays in data for `npm run i18n`, without
// loading the catalogs (src/i18n/index.js). The UI shows it later through t().
// Browser-only modules import msg from src/i18n/index.js instead.

/** Mark English text that is stored in data and translated later by t(). */
export const msg = (text) => text;

/**
 * English for marked text, its `{name}` slots filled from `values`; a slot
 * without one stays as written.
 */
export function englishText(text, values) {
  return String(text).replace(/\{(\w+)\}/g, (slot, name) =>
    values && Object.hasOwn(values, name) ? String(values[name]) : slot,
  );
}
