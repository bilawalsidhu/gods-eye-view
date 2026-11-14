/**
 * @file Country lookup.
 *
 * `countryForIcao24(hex)` names the state of registry behind an ADS-B contact's
 * ICAO 24-bit address, using the allocation table of ICAO Annex 10 Vol III
 * chapter 9. `countryEntry(iso2)` resolves an ISO 3166-1 alpha-2 code. A hex
 * address outside every allocated block, and a code that is not a country,
 * return null. The catalog is built offline by
 * scripts/build-country-catalog.mjs and bundled, so lookup is pure and
 * synchronous, with no network at view time.
 */

import catalog from './catalog.json' with { type: 'json' };
import { normalizeIso2, parseIcao24 } from './naming.js';

/**
 * @typedef {object} CountryEntry
 * @property {string} iso2 ISO 3166-1 alpha-2, the key.
 * @property {string} iso3 ISO 3166-1 alpha-3.
 * @property {string} name Display name.
 * @property {string} flag Flag emoji computed from `iso2`.
 * @property {string[]} regPrefixes Civil aircraft registration prefixes, `[]` when unknown.
 * @property {[string, string][]} icao24Ranges Inclusive six-digit hex blocks, `[]` when none.
 */

/**
 * Build an ISO code resolver over a catalog array. Exposed so the validator and
 * tests can resolve against a catalog they pass in rather than the bundled one.
 * @param {CountryEntry[]} entries
 * @returns {(iso2: string|null|undefined) => CountryEntry|null}
 */
export function buildLookup(entries) {
  const byIso2 = new Map(entries.map((entry) => [entry.iso2, entry]));
  return (iso2) => byIso2.get(normalizeIso2(iso2)) ?? null;
}

/**
 * Build an address resolver over a catalog array: every block sorted by its
 * start, then a binary search for the last block starting at or below the
 * address. Correct because blocks do not overlap, which `validateCountryCatalog`
 * enforces.
 * @param {CountryEntry[]} entries
 * @returns {(hex: string|number|null|undefined) => CountryEntry|null}
 */
export function buildIcao24Lookup(entries) {
  const blocks = [];
  for (const entry of entries)
    for (const [start, end] of entry.icao24Ranges)
      blocks.push({
        start: Number.parseInt(start, 16),
        end: Number.parseInt(end, 16),
        entry,
      });
  blocks.sort((a, b) => a.start - b.start);
  return (hex) => {
    const value = parseIcao24(hex);
    if (value < 0) return null;
    let low = 0;
    let high = blocks.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (blocks[mid].start <= value) {
        found = mid;
        low = mid + 1;
      } else high = mid - 1;
    }
    return found >= 0 && value <= blocks[found].end
      ? blocks[found].entry
      : null;
  };
}

const byIso2 = buildLookup(catalog);
const byIcao24 = buildIcao24Lookup(catalog);

/**
 * Resolve an ISO 3166-1 alpha-2 code, in any case, to its entry, or null.
 * @param {string|null|undefined} iso2
 * @returns {CountryEntry|null}
 */
export function countryEntry(iso2) {
  return byIso2(iso2);
}

/**
 * The country that holds the ICAO 24-bit address block containing `hex`, or null.
 * @param {string|number|null|undefined} hex Six hex digits, with an optional `0x`.
 * @returns {CountryEntry|null}
 */
export function countryForIcao24(hex) {
  return byIcao24(hex);
}

/**
 * Every country in ISO alpha-2 order.
 * @returns {CountryEntry[]}
 */
export function allCountries() {
  return catalog;
}

export { catalog };
