/**
 * Airport lookups use the bundled public-domain OurAirports pack on first use.
 * See local_data/ourairports/README.md for the source and row format.
 * A missing pack (HTTP 404) yields no matches for the session.
 */

import { createRetryableLoader } from './retryableLoad.js';

const PLAIN_LETTERS = {
  ł: 'l',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ı: 'i',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  þ: 'th',
};

/**
 * A name as the lookups compare it: lower case, without accents on Latin
 * letters ("Zürich" reads as "zurich"); marks in other scripts (Hindi, Thai)
 * carry meaning and stay. Kept here so the airports pack does not load the
 * cities pack's module.
 */
export const foldName = (name) =>
  String(name || '')
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .toLocaleLowerCase('en')
    .replace(/[łøđðıßæœþ]/g, (letter) => PLAIN_LETTERS[letter])
    .trim();

/** How close a picked spot must be to an airport for the place line's link. */
export const NEAR_AIRPORT_KM = 2;

const CELL_DEG = 1;
const EARTH_KM = 6371;
const rad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in km. */
function distanceKm(lat1, lon1, lat2, lon2) {
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) *
      Math.cos(rad(lat2)) *
      Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const wrapLon = (lon) => (((lon % 360) + 540) % 360) - 180;
const cellKey = (lat, lon) =>
  `${Math.floor(lat / CELL_DEG)},${Math.floor(wrapLon(lon) / CELL_DEG)}`;

/**
 * One row of the pack, read into an airport.
 * @param {Array} row
 * @returns {{ident: string, iata: string, icao?: string, name: string, lat: number, lon: number, size: string, city: string, country: string, elevationFt: ?number, runways: number}}
 */
export function toAirport(row) {
  const [
    ident,
    iata,
    name,
    lat,
    lon,
    size,
    city,
    country,
    elevationFt,
    runways,
    icao,
  ] = row;
  return {
    ident: String(ident || ''),
    iata: String(iata || ''),
    ...(icao ? { icao: String(icao) } : {}),
    name: String(name || ''),
    lat: Number(lat),
    lon: Number(lon),
    size: String(size || ''),
    city: String(city || ''),
    country: String(country || ''),
    elevationFt: Number.isFinite(elevationFt) ? elevationFt : null,
    runways: Number.isFinite(runways) ? runways : 0,
  };
}

/** Whether a row is usable: a code, a name and a position. */
const validRow = (row) =>
  Array.isArray(row) &&
  row[0] &&
  row[2] &&
  Number.isFinite(row[3]) &&
  Number.isFinite(row[4]);

/**
 * Index a pack's rows: by one-degree cell for "near here", and by code for
 * "AUS" or "KAUS".
 * @param {Array<Array>} rows
 */
export function indexAirports(rows) {
  const cells = new Map();
  const codes = new Map();
  const airports = [];
  const names = new Map();
  const searchable = [];
  for (const row of rows || []) {
    if (!validRow(row)) continue;
    const airport = toAirport(row);
    airports.push(airport);
    const key = cellKey(airport.lat, airport.lon);
    const cell = cells.get(key);
    if (cell) cell.push(airport);
    else cells.set(key, [airport]);
    const name = nameWords(airport.name);
    const whole = name.join(' ');
    const sameName = names.get(whole);
    if (sameName) sameName.push(airport);
    else names.set(whole, [airport]);
    searchable.push({
      airport,
      city: nameWords(airport.city).join(' '),
      name: withoutAirportWords(name),
    });
    for (const code of [airport.ident, airport.iata, airport.icao])
      if (code && !codes.has(code.toUpperCase()))
        codes.set(code.toUpperCase(), airport);
  }
  return { airports, cells, codes, names, searchable };
}

/**
 * Airports within `radiusKm` of a point, nearest first, each with its
 * `distanceKm`.
 * @param {{cells: Map}} index
 */
export function airportsWithin(index, lat, lon, radiusKm) {
  if (!index || !Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const angle = radiusKm / EARTH_KM;
  const latSpan = Math.ceil((angle * 180) / Math.PI / CELL_DEG);
  // A circle reaching either pole includes every meridian.
  const lonSpan =
    angle >= Math.PI / 2 - Math.abs(rad(lat))
      ? 180
      : Math.ceil(
          (Math.asin(Math.sin(angle) / Math.cos(rad(lat))) * 180) /
            Math.PI /
            CELL_DEG,
        );
  const found = [];
  const seen = new Set();
  for (let dy = -latSpan; dy <= latSpan; dy++)
    for (let dx = -lonSpan; dx <= lonSpan; dx++) {
      const key = cellKey(lat + dy * CELL_DEG, lon + dx * CELL_DEG);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const airport of index.cells.get(key) || []) {
        const km = distanceKm(lat, lon, airport.lat, airport.lon);
        if (km <= radiusKm) found.push({ ...airport, distanceKm: km });
      }
    }
  return found.sort((a, b) => a.distanceKm - b.distanceKm);
}

const SIZE_RANK = { large: 0, medium: 1, small: 2 };
/** How far from where a search landed an airport named only by words in its name may be. */
export const NAME_NEAR_KM = 100;
const LANDED_AT_KM = 5;
const AIRPORT_NOUNS = new Set(
  'airport airfield aerodrome aeroport aeroportul aeropuerto aeroporto aeroporti flughafen flugplatz luchthaven lufthavn flygplats lotnisko letiste lentoasema havalimani repuloter аэропорт аеропорт аэродром'.split(
    ' ',
  ),
);
const NAME_FILLERS = new Set(
  'international intl regional field internacional internazionale lotniczy port'.split(
    ' ',
  ),
);
const nameWords = (text) => foldName(text).match(/[\p{L}\p{M}\p{N}]+/gu) || [];
const withoutAirportWords = (words) =>
  words
    .filter((word) => !AIRPORT_NOUNS.has(word) && !NAME_FILLERS.has(word))
    .join(' ');
const airportLine = (text) =>
  String(text || '')
    .normalize('NFKC')
    .trim();

// Match the end of the place name, before any comma-separated address.
// A station or car park can start with the same airport name.
const AIRPORT_SUFFIX = /(?:空港|机场|機場|공항)(?:\s*\([A-Z0-9]{3,4}\))?$/u;
const hasAirportNoun = (line, words) =>
  words.some((word) => AIRPORT_NOUNS.has(word)) ||
  AIRPORT_SUFFIX.test(line.split(/[,、]/u, 1)[0].trimEnd());

/** Whether the label contains a word for an airport. */
export const namesAirport = (text) =>
  hasAirportNoun(airportLine(text), nameWords(text));

/** Whether a whole line could be a three- or four-character airport code. */
export const isAirportCode = (text) =>
  /^(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{3,4}$/.test(airportLine(text));

/**
 * Find a code, full catalog name, or airport named by a phrase such as
 * "Heathrow airport". Prefer matches near the landing point, then size.
 * @param {ReturnType<typeof indexAirports>} index
 * @param {string} query
 * @param {{lat: number, lon: number}|null} near Where the search landed.
 */
export function findAirportIn(index, query, near = null) {
  const line = airportLine(query);
  if (!index || !line) return null;
  if (isAirportCode(line) && line === line.toUpperCase()) {
    const byCode = index.codes.get(line);
    if (byCode) return byCode;
  }
  const words = nameWords(line);
  const landed = Number.isFinite(near?.lat) && Number.isFinite(near?.lon);
  const away = (airport) =>
    landed ? distanceKm(near.lat, near.lon, airport.lat, airport.lon) : 0;
  let exact = null;
  let closest = Infinity;
  for (const airport of index.names.get(words.join(' ')) || []) {
    const km = away(airport);
    if (km <= NAME_NEAR_KM && km < closest) {
      exact = airport;
      closest = km;
    }
  }
  if (exact) return exact;
  if (!hasAirportNoun(line, words)) return null;
  const phrase = withoutAirportWords(words);
  if (!phrase) return null;

  // A leading city phrase or IATA code can match worldwide. A phrase
  // inside the airport name only counts near the landing point.
  const hits = [];
  for (const { airport, city, name } of index.searchable) {
    const cityOrCode =
      city === phrase ||
      city.startsWith(phrase + ' ') ||
      airport.iata.toLowerCase() === phrase;
    if (!cityOrCode && !` ${name} `.includes(` ${phrase} `)) continue;
    const km = away(airport);
    if (cityOrCode || km <= NAME_NEAR_KM) hits.push({ airport, km });
  }
  hits.sort(
    (a, b) =>
      Number(a.km > NAME_NEAR_KM) - Number(b.km > NAME_NEAR_KM) ||
      (SIZE_RANK[a.airport.size] ?? 3) - (SIZE_RANK[b.airport.size] ?? 3) ||
      a.km - b.km,
  );
  const best = hits[0];
  if (landed && (!best || best.km > NAME_NEAR_KM)) {
    // A localized label can differ completely from the catalog's name.
    const at = airportsWithin(index, near.lat, near.lon, LANDED_AT_KM)[0];
    if (at) return index.codes.get(at.ident.toUpperCase()) ?? at;
  }
  return best?.airport || null;
}

/**
 * The airport a line is exactly the code of ("SFO", "KSFO"), or null. In
 * capitals any airport's code counts; typed in lower case ("aus", "sea")
 * only a large airport's, since short words are often places too.
 * @param {ReturnType<typeof indexAirports>} index
 * @param {string} query
 */
export function airportByCodeIn(index, query) {
  const line = airportLine(query);
  if (!index || !isAirportCode(line)) return null;
  const airport = index.codes.get(line.toUpperCase());
  if (!airport) return null;
  return line === line.toUpperCase() || airport.size === 'large'
    ? airport
    : null;
}

/** ISO 3166-1 alpha-3 country codes. */
const COUNTRY_CODES = new Set(
  `ABW AFG AGO AIA ALA ALB AND ARE ARG ARM ASM ATA ATF ATG AUS AUT AZE BDI
BEL BEN BES BFA BGD BGR BHR BHS BIH BLM BLR BLZ BMU BOL BRA BRB BRN BTN
BVT BWA CAF CAN CCK CHE CHL CHN CIV CMR COD COG COK COL COM CPV CRI CUB
CUW CXR CYM CYP CZE DEU DJI DMA DNK DOM DZA ECU EGY ERI ESH ESP EST ETH
FIN FJI FLK FRA FRO FSM GAB GBR GEO GGY GHA GIB GIN GLP GMB GNB GNQ GRC
GRD GRL GTM GUF GUM GUY HKG HMD HND HRV HTI HUN IDN IMN IND IOT IRL IRN
IRQ ISL ISR ITA JAM JEY JOR JPN KAZ KEN KGZ KHM KIR KNA KOR KWT LAO LBN
LBR LBY LCA LIE LKA LSO LTU LUX LVA MAC MAF MAR MCO MDA MDG MDV MEX MHL
MKD MLI MLT MMR MNE MNG MNP MOZ MRT MSR MTQ MUS MWI MYS MYT NAM NCL NER
NFK NGA NIC NIU NLD NOR NPL NRU NZL OMN PAK PAN PCN PER PHL PLW PNG POL
PRI PRK PRT PRY PSE PYF QAT REU ROU RUS RWA SAU SDN SEN SGP SGS SHN SJM
SLB SLE SLV SMR SOM SPM SRB SSD STP SUR SVK SVN SWE SWZ SXM SYC SYR TCA
TCD TGO THA TJK TKL TKM TLS TON TTO TUN TUR TUV TWN TZA UGA UKR UMI URY
USA UZB VAT VCT VEN VGB VIR VNM VUT WLF WSM YEM ZAF ZMB ZWE`.split(/\s+/),
);

/** Whether a typed code could name a country as well as an airport. */
export const isAirportCountryCode = (query) =>
  COUNTRY_CODES.has(airportLine(query).toUpperCase());

/** An airport's short code for its card and links: IATA, else its ident. */
export const airportCode = (airport) => airport?.iata || airport?.ident || '';

/**
 * Read a pack (its JSON) through `fetchImpl`. A pack that is not there
 * (404) is an empty pack, kept for the session; any other failure is
 * retried later.
 */
export async function readAirportsPack(fetchImpl, url) {
  const response = await fetchImpl(url);
  if (response.status === 404)
    return { meta: null, missing: true, ...indexAirports([]) };
  if (!response.ok) throw new Error(`airports pack: HTTP ${response.status}`);
  const pack = await response.json();
  return {
    meta: pack?.meta || null,
    missing: false,
    ...indexAirports(pack?.rows),
  };
}

let loader = null;
let fetcher = (...args) => globalThis.fetch(...args);
/** The indexed pack, loaded once; a failed load is retried after a pause. */
export function loadAirports() {
  // Vite bundles the pack from this literal URL.
  loader ??= createRetryableLoader(() =>
    readAirportsPack(
      fetcher,
      new URL('./local_data/ourairports/airports.json', import.meta.url),
    ),
  );
  return loader();
}

/** Tests: read the pack through `fetchImpl` from the next load on. */
export function _setAirportsFetchForTest(fetchImpl) {
  fetcher = fetchImpl || ((...args) => globalThis.fetch(...args));
  loader = null;
}

/** Airports near a point, nearest first; none without the pack. */
export async function airportsNear(lat, lon, radiusKm = NEAR_AIRPORT_KM) {
  try {
    return airportsWithin(await loadAirports(), lat, lon, radiusKm);
  } catch {
    return [];
  }
}

/**
 * Resolve the key carried by an explicit airport row or saved recent.
 * A catalog ident (e.g. NG-0005) can be longer than a typed airport code.
 */
export async function findPickedAirport(key) {
  const index = await loadAirports();
  return index?.codes.get(airportLine(key).toUpperCase()) ?? null;
}

/** The airport a typed line names, or null (also without the pack). */
export async function findAirport(query, near = null) {
  try {
    return findAirportIn(await loadAirports(), query, near);
  } catch {
    return null;
  }
}

/** The airport a line is exactly the code of, or null (also without the pack). */
export async function findAirportByCode(query) {
  try {
    return airportByCodeIn(await loadAirports(), query);
  } catch {
    return null;
  }
}
