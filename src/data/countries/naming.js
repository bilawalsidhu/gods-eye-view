/**
 * @file Country token normalisation.
 *
 * Shared by the runtime lookup (index.js), the validator (validate.js) and the
 * offline builders (scripts/build-country-catalog.mjs and
 * build-airline-catalog.mjs), so a code, a name and a hex address map to the
 * same key everywhere. Pure: no imports, safe in the browser and in Node.
 */

const REGIONAL_INDICATOR_A = 0x1f1e6;

/**
 * Fold an ISO 3166-1 alpha-2 code to its stored form, or '' when it is not two
 * ASCII letters.
 * @param {unknown} code
 * @returns {string}
 */
export function normalizeIso2(code) {
  const value = String(code ?? '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : '';
}

/**
 * Fold a country name to a comparison key: lower-case, accents removed, every
 * run of other characters collapsed to one space, e.g.
 * `Côte d'Ivoire` -> `cote d ivoire`.
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The flag emoji of a country: its two letters as regional-indicator symbols.
 * Computed, so no flag image is bundled. Returns '' for an invalid code.
 * @param {unknown} iso2
 * @returns {string}
 */
export function flagOf(iso2) {
  const code = normalizeIso2(iso2);
  if (!code) return '';
  return String.fromCodePoint(
    ...[...code].map((c) => REGIONAL_INDICATOR_A + c.charCodeAt(0) - 65),
  );
}

/**
 * Parse an ICAO 24-bit Mode-S address to its numeric value. Strips a `0x`
 * prefix and whitespace and reads 1 to 6 hex digits, so a feed that dropped a
 * leading zero still resolves. Anything else, including a TIS-B `~` address or a
 * seventh digit, returns -1.
 * @param {unknown} hex
 * @returns {number} 0 to 0xFFFFFF, or -1 when not an address.
 */
export function parseIcao24(hex) {
  if (typeof hex === 'number')
    return Number.isInteger(hex) && hex >= 0 && hex <= 0xffffff ? hex : -1;
  const digits = String(hex ?? '')
    .replace(/\s+/g, '')
    .replace(/^0x/i, '');
  return /^[0-9a-f]{1,6}$/i.test(digits) ? Number.parseInt(digits, 16) : -1;
}

/**
 * Format an address value as its six-digit upper-case hex string.
 * @param {number} value
 * @returns {string}
 */
export function formatIcao24(value) {
  return value.toString(16).toUpperCase().padStart(6, '0');
}
