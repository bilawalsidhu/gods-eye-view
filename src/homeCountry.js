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
 * Look straight down over the visitor's country from the start height.
 * Use the default start view when the country is unknown.
 * @param {{timeZone?: string|null, languages?: readonly string[]}} [where]
 */
export function homeCountryView(where = {}) {
  const centre = COUNTRY_CENTRES[homeCountry(where)];
  if (!centre) return START_VIEW;
  const [lat, lon] = centre;
  return Object.freeze({ lon, lat, height: START_VIEW.height });
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
