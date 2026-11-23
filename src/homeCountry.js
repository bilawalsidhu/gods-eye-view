import { COUNTRY_CENTRES, ZONE_COUNTRIES } from './data/homeCountries.js';
import { START_VIEW } from './camera.js';

/**
 * The visitor's country, guessed from the browser's time zone and, for a zone
 * that belongs to no country (UTC), the region of a preferred language
 * ("en-GB"). Nothing leaves the browser. Null when neither names one.
 * @param {{timeZone?: string|null, languages?: readonly string[]}} [where]
 * @returns {string|null} ISO 3166 code, e.g. 'DE'
 */
export function homeCountry({
  timeZone = currentTimeZone(),
  languages = globalThis.navigator?.languages ?? [],
} = {}) {
  const byZone = ZONE_COUNTRIES[timeZone];
  if (byZone) return byZone;
  for (const language of languages) {
    const region = regionOf(language);
    if (region && COUNTRY_CENTRES[region]) return region;
  }
  return null;
}

/**
 * The start view over the visitor's country: the planet from `base.height`,
 * looking straight down on the country's centre. `base` where the country is
 * unknown.
 * @param {{timeZone?: string|null, languages?: readonly string[],
 *   base?: {lon: number, lat: number, height: number}}} [where]
 */
export function homeCountryView({ base = START_VIEW, ...where } = {}) {
  const centre = COUNTRY_CENTRES[homeCountry(where)];
  if (!centre) return base;
  const [lat, lon] = centre;
  return Object.freeze({ lon, lat, height: base.height });
}

function currentTimeZone() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function regionOf(language) {
  try {
    return new Intl.Locale(language).region ?? null;
  } catch {
    return null;
  }
}
