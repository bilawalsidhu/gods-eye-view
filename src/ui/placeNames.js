/**
 * Preset place names as the page shows them.
 *
 * The preset cities in src/cityPois.js keep their English names in data:
 * those are what voice tools, the AI model, share links and lookups match on.
 * This helper translates a known English name at a presentation boundary
 * only; any other place (a geocoded address, a name the model chose) is shown
 * as given.
 *
 * Pure: imports only i18n, no DOM.
 * @module ui/placeNames
 */
import { msg, t } from '../i18n/index.js';

// The preset cities (CITY_POIS names, kept in step by placeNames.test.mjs),
// and Los Angeles, which voice results name for the analyst's region scopes.
const PLACE_NAME_KEYS = new Map(
  [
    msg('Austin'),
    msg('San Francisco'),
    msg('New York'),
    msg('Tokyo'),
    msg('London'),
    msg('Paris'),
    msg('Dubai'),
    msg('Washington DC'),
    msg('Tallinn'),
    msg('Vancouver'),
    msg('Los Angeles'),
  ].map((key) => [key, key]),
);

/**
 * A preset place name in the active language; any other text unchanged.
 * @param {string} name English place name, e.g. `Tokyo`.
 * @returns {string}
 */
export function localizePlaceName(name) {
  if (typeof name !== 'string') return name;
  const key = PLACE_NAME_KEYS.get(name.trim());
  return key ? t(key) : name;
}

/** The English names this module translates (for tests). */
export const KNOWN_PLACE_NAMES = Object.freeze([...PLACE_NAME_KEYS.keys()]);
