/**
 * @file Airline lookup.
 *
 * `airlineForCallsign(callsign)` names the operator behind an ADS-B contact: an
 * airline callsign starts with the airline's ICAO three-letter designator
 * followed by a flight number (`SWR100`, `BAW23G`). `airlineEntry(icao)`
 * resolves a designator directly. A callsign that is a registration (`N123AB`),
 * a four-letter prefix or an unknown designator returns null. The catalog is
 * built offline by scripts/build-airline-catalog.mjs and bundled, so
 * lookup is pure and synchronous, with no network at view time.
 */

import catalog from './catalog.json' with { type: 'json' };
import { callsignPrefix, normalizeIcao } from './naming.js';

/**
 * @typedef {object} AirlineEntry
 * @property {string} icao ICAO three-letter designator, the key.
 * @property {string|null} iata IATA two-character code.
 * @property {string} name
 * @property {string|null} callsign Radiotelephony callsign word.
 * @property {string|null} country ISO 3166-1 alpha-2, joins the country library.
 * @property {boolean} active
 * @property {string|null} tailColor Brand colour as `#RRGGBB`, curated majors only.
 */

/**
 * Build a designator resolver over a catalog array. Exposed so the validator
 * and tests can resolve against a catalog they pass in rather than the bundled one.
 * @param {AirlineEntry[]} entries
 * @returns {(icao: string|null|undefined) => AirlineEntry|null}
 */
export function buildLookup(entries) {
  const byIcao = new Map(entries.map((entry) => [entry.icao, entry]));
  return (icao) => byIcao.get(normalizeIcao(icao)) ?? null;
}

const lookup = buildLookup(catalog);

/**
 * Resolve an ICAO three-letter designator, in any case, to its entry, or null.
 * @param {string|null|undefined} icao
 * @returns {AirlineEntry|null}
 */
export function airlineEntry(icao) {
  return lookup(icao);
}

/**
 * The airline whose designator opens `callsign`, or null.
 * @param {string|null|undefined} callsign
 * @returns {AirlineEntry|null}
 */
export function airlineForCallsign(callsign) {
  return lookup(callsignPrefix(callsign));
}

/**
 * Every airline in ICAO designator order.
 * @returns {AirlineEntry[]}
 */
export function allAirlines() {
  return catalog;
}

export { catalog };
