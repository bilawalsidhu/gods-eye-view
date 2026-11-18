/**
 * The bundled world cities pack (Wikidata, CC0), read from
 * `local_data/wikidata_cities/cities.json` (built by
 * scripts/build-wikidata-cities.mjs). The file loads once, on first use, and
 * every answer comes from it: no place service is called.
 *
 * Rows are `[name, lat, lon, population, country, wikidata]`, largest first.
 */

const CELL_DEG = 1;

// Letters that are not a base letter plus an accent, so NFD leaves them.
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
 * A name as the lookups compare it: lower case, without accents, so
 * "sao paulo" finds São Paulo, "zurich" Zürich, "lodz" Łódź and "tromso"
 * Tromsø.
 */
export const foldName = (name) =>
  String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[łøđðıßæœþ]/g, (letter) => PLAIN_LETTERS[letter])
    .trim();
const EARTH_KM = 6371;
const rad = (deg) => (deg * Math.PI) / 180;

function distanceKm(lat1, lon1, lat2, lon2) {
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) *
      Math.cos(rad(lat2)) *
      Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const cellKey = (lat, lon) =>
  `${Math.floor(lat / CELL_DEG)},${Math.floor(((((lon % 360) + 540) % 360) - 180) / CELL_DEG)}`;

/** Group rows by one-degree cell so a lookup reads only the cells near it. */
export function indexCities(rows) {
  const cells = new Map();
  for (const row of rows) {
    const key = cellKey(row[1], row[2]);
    const cell = cells.get(key);
    if (cell) cell.push(row);
    else cells.set(key, [row]);
  }
  return cells;
}

/** Rows by folded name, each list in the rows' own order (largest first). */
export function indexNames(rows) {
  const names = new Map();
  for (const row of rows) {
    const key = foldName(row[0]);
    const list = names.get(key);
    if (list) list.push(row);
    else names.set(key, [row]);
  }
  return names;
}

function toCity(row, km) {
  return {
    name: row[0],
    latitude: row[1],
    longitude: row[2],
    population: row[3],
    country: row[4] || null,
    wikidata: row[5],
    distanceKm: km,
  };
}

/**
 * Half the longitude a circle spans, in degrees: 180 when it reaches a pole,
 * where every meridian passes through it.
 */
export function lonHalfSpan(latitude, radiusKm) {
  const angle = radiusKm / EARTH_KM;
  const fromPole = Math.PI / 2 - Math.abs(rad(latitude));
  if (angle >= fromPole) return 180;
  return (Math.asin(Math.sin(angle) / Math.cos(rad(latitude))) * 180) / Math.PI;
}
const latHalfSpan = (radiusKm) => ((radiusKm / EARTH_KM) * 180) / Math.PI;

/** Rows within `radiusKm` of a point, each with its distance. */
export function citiesWithin(cells, latitude, longitude, radiusKm) {
  const latSpan = Math.ceil(latHalfSpan(radiusKm) / CELL_DEG);
  const lonSpan = Math.ceil(lonHalfSpan(latitude, radiusKm) / CELL_DEG);
  const found = [];
  const seen = new Set();
  for (let dLat = -latSpan; dLat <= latSpan; dLat++) {
    const lat = latitude + dLat * CELL_DEG;
    if (lat < -90 - CELL_DEG || lat > 90 + CELL_DEG) continue;
    for (
      let dLon = -Math.min(lonSpan, 180);
      dLon <= Math.min(lonSpan, 180);
      dLon++
    ) {
      const key = cellKey(lat, longitude + dLon * CELL_DEG);
      if (seen.has(key)) continue;
      seen.add(key);
      for (const row of cells.get(key) || []) {
        const km = distanceKm(latitude, longitude, row[1], row[2]);
        if (km <= radiusKm) found.push(toCity(row, km));
      }
    }
  }
  return found;
}

// Each country in the pack by what a qualifier may call it: its code, its
// English name and its name in the page language, folded.
function countryNames(rows) {
  const names = new Map();
  for (const code of new Set(rows.map((row) => row[4]).filter(Boolean))) {
    for (const name of [code, countryName(code, 'en'), countryName(code)])
      names.set(foldName(name), code);
  }
  return names;
}

let loading = null;
/** The indexed pack; a failed load is retried on the next call. */
export function loadCities(fetchImpl = (...args) => globalThis.fetch(...args)) {
  loading ??= fetchImpl(
    new URL('./local_data/wikidata_cities/cities.json', import.meta.url),
  )
    .then((response) => {
      if (!response.ok) throw new Error(`cities pack: HTTP ${response.status}`);
      return response.json();
    })
    .then((pack) => ({
      meta: pack.meta,
      rows: pack.rows,
      cells: indexCities(pack.rows),
      names: indexNames(pack.rows),
      countries: countryNames(pack.rows),
    }))
    .catch((error) => {
      loading = null;
      throw error;
    });
  return loading;
}

/**
 * The city a point is in or nearest to: the largest within `nearKm`, else the
 * nearest within `radiusKm`, else null. Preferring the largest nearby keeps a
 * view over a metropolis from being named after one of its suburbs.
 */
export async function nearestCity(
  latitude,
  longitude,
  { radiusKm = 60, nearKm = 12 } = {},
) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const { cells } = await loadCities();
  const found = citiesWithin(cells, latitude, longitude, radiusKm);
  if (!found.length) return null;
  const near = found.filter((city) => city.distanceKm <= nearKm);
  if (near.length)
    return near.reduce((a, b) => (b.population > a.population ? b : a));
  return found.reduce((a, b) => (b.distanceKm < a.distanceKm ? b : a));
}

/** Cities around a point, most populous first. */
export async function citiesAround({
  latitude,
  longitude,
  radiusKm = 50,
  limit = 8,
  minPopulation = 0,
}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  const { cells } = await loadCities();
  return citiesWithin(cells, latitude, longitude, radiusKm)
    .filter((city) => city.population >= minPopulation)
    .sort((a, b) => b.population - a.population || a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

/** A country's name in the page language, from its ISO code. */
export function countryName(
  code,
  language = globalThis.document?.documentElement?.lang || 'en',
) {
  if (!code) return null;
  try {
    return (
      new Intl.DisplayNames([language], { type: 'region' }).of(code) || code
    );
  } catch {
    return code;
  }
}

/**
 * The city with this name, or null. A qualifier after a comma that names a
 * country ("Paris, France", "Paris, US") keeps only cities there, and finds
 * nothing when none is; one that names no country ("Paris, Texas") is
 * ignored. A city of that name within `radiusKm` of `near` (the view) wins,
 * the nearest first, else the largest city of that name anywhere.
 */
export async function findPlace(
  name,
  { near = null, radiusKm = 150 } = {},
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  const [head, ...rest] = String(name || '').split(',');
  const wanted = foldName(head);
  if (!wanted) return null;
  const qualifier = foldName(rest.join(','));
  const { names, countries } = await loadCities(fetchImpl);
  const country = qualifier ? countries.get(qualifier) : undefined;
  const cities = (names.get(wanted) || []).filter(
    (row) => !country || row[4] === country,
  );
  if (!cities.length) return null;
  if (Number.isFinite(near?.latitude) && Number.isFinite(near?.longitude)) {
    let best = null;
    for (const row of cities) {
      const km = distanceKm(near.latitude, near.longitude, row[1], row[2]);
      if (km <= radiusKm && (!best || km < best.distanceKm))
        best = toCity(row, km);
    }
    if (best) return best;
  }
  return toCity(cities[0], 0);
}
