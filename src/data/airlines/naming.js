/**
 * @file Airline token normalisation.
 *
 * Shared by the runtime lookup (index.js), the validator (validate.js) and the
 * offline builder (scripts/build-airline-catalog.mjs). Pure: no imports,
 * safe in the browser and in Node.
 */

/**
 * Fold an ICAO airline designator to its stored form, or '' when it is not
 * three ASCII letters.
 * @param {unknown} code
 * @returns {string}
 */
export function normalizeIcao(code) {
  const value = String(code ?? '')
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : '';
}

/**
 * The leading run of letters of a callsign, upper-cased: `swr100` -> `SWR`,
 * `BAW23G` -> `BAW`, `N123AB` -> `N`. Empty when the callsign does not start
 * with a letter.
 * @param {unknown} callsign
 * @returns {string}
 */
export function callsignPrefix(callsign) {
  const match = /^[A-Za-z]+/.exec(String(callsign ?? '').trim());
  return match ? match[0].toUpperCase() : '';
}
