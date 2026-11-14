/**
 * @file Curated inputs for scripts/build-country-catalog.mjs and
 * build-airline-catalog.mjs.
 *
 * `SOURCE_URLS` names the three fact sources. `DISPLAY_NAMES` replaces an ISO
 * 3166 formal name with the name people use. `NAME_ALIASES` maps every other
 * spelling found in the ICAO allocation table or in OpenFlights to its ISO
 * alpha-2 code, so a name resolves to the same country in both builders. A name
 * that is in neither the ISO list nor this map is unmatched: the country builder
 * fails on an unmatched allocation block unless it is one of the non-country
 * blocks of `NON_COUNTRY_BLOCK`, and the airline builder leaves the airline's
 * country null and counts it.
 */

export const SOURCE_URLS = Object.freeze({
  iso3166:
    'https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/master/all/all.csv',
  icaoRanges:
    'https://raw.githubusercontent.com/flightaware/dump1090/master/public_html/flags.js',
  openflightsAirlines:
    'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat',
});

/** ISO alpha-2 -> the name the catalog shows, where the ISO formal name is not it. */
export const DISPLAY_NAMES = Object.freeze({
  BO: 'Bolivia',
  CD: 'Democratic Republic of the Congo',
  FM: 'Micronesia',
  GB: 'United Kingdom',
  IR: 'Iran',
  KP: 'North Korea',
  KR: 'South Korea',
  LA: 'Laos',
  MD: 'Moldova',
  NL: 'Netherlands',
  PS: 'Palestine',
  RU: 'Russia',
  SY: 'Syria',
  TR: 'Turkey',
  TW: 'Taiwan',
  TZ: 'Tanzania',
  US: 'United States',
  VE: 'Venezuela',
  VN: 'Vietnam',
});

/**
 * Allocation blocks that are not a state: unassigned regional space and ICAO's
 * own. Their ranges are dropped from the catalog and listed in the build summary.
 */
export const NON_COUNTRY_BLOCK = /^(Unassigned|ICAO)\b/i;

/** Alternative spellings -> ISO alpha-2. Source of each group in its comment. */
export const NAME_ALIASES = Object.freeze({
  // ICAO Annex 10 allocation table, as dump1090 spells it
  'Cape Verde': 'CV',
  'Czech Republic': 'CZ',
  "Democratic People's Republic of Korea": 'KP',
  'Democratic Republic of the Congo': 'CD',
  'Libyan Arab Jamahiriya': 'LY',
  'Republic of Korea': 'KR',
  'Republic of Moldova': 'MD',
  Swaziland: 'SZ',
  'The former Yugoslav Republic of Macedonia': 'MK',
  'United Republic of Tanzania': 'TZ',
  // OpenFlights
  Brunei: 'BN',
  Burma: 'MM',
  'Congo (Kinshasa)': 'CD',
  'Democratic Republic of Congo': 'CD',
  'Hong Kong SAR of China': 'HK',
  'Ivory Coast': 'CI',
  'Lao Peoples Democratic Republic': 'LA',
  Macedonia: 'MK',
  'Macau SAR of China': 'MO',
  Netherland: 'NL',
  'Republic of the Congo': 'CG',
  'Russian Federation': 'RU',
  'Somali Republic': 'SO',
  'Syrian Arab Republic': 'SY',
});
