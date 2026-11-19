/**
 * The bundled world cities pack (Wikidata, CC0), read from
 * `local_data/wikidata_cities/cities.json` (built by
 * scripts/build-wikidata-cities.mjs). The cities pack and optional detail
 * tiles load on first use. All answers are offline.
 *
 * Rows are `[name, lat, lon, population, country, wikidata]`, largest first.
 */

import { createRetryableLoader } from './retryableLoad.js';

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

const TILE_DEG = 5;
/**
 * Detail tiles kept in memory, least recently used first out: 64 tiles is
 * far more than one lookup touches, and bounds what a long session keeps.
 */
const MAX_TILES = 64;
/**
 * How far out small places are looked for, in km. 500 km is under the 556 km
 * that 5 degrees of latitude span, so a lookup's tile box reaches at most one
 * tile past the point's own on each side: 3 rows, and 3 columns at the
 * equator (more toward the poles, where tiles narrow). A lookup asked for a
 * wider radius, up to the whole globe, still reads only those tiles; cities
 * count to its full radius.
 */
export const PLACE_TILE_KM = 500;
const NAMED = /\p{L}/u;
const tiles = new Map();
let loadTileIndex;

/** The detail tiles touched by the circle's enclosing latitude/longitude box. */
function tileKeysAround(latitude, longitude, radiusKm) {
  const latSpan = latHalfSpan(radiusKm);
  const lonSpan = lonHalfSpan(latitude, radiusKm);
  const latOrigin = (lat) =>
    Math.min(85, Math.floor(lat / TILE_DEG) * TILE_DEG);
  const south = latOrigin(Math.max(-90, latitude - latSpan));
  const north = latOrigin(Math.min(90, latitude + latSpan));
  const lon = (((longitude % 360) + 540) % 360) - 180;
  const west = Math.floor((lon - lonSpan) / TILE_DEG) * TILE_DEG;
  const east = Math.floor((lon + lonSpan) / TILE_DEG) * TILE_DEG;
  const keys = [];
  for (let lat = south; lat <= north; lat += TILE_DEG) {
    for (let lon = west; lon <= east && lon < west + 360; lon += TILE_DEG) {
      keys.push(`${lat}_${((lon + 540) % 360) - 180}`);
    }
  }
  return keys;
}

async function readPlaceTiles(latitude, longitude, radiusKm, fetchImpl) {
  const { INDEX_URL, TILE_URLS } =
    await import('./local_data/wikidata_places/files.js');
  loadTileIndex ??= createRetryableLoader(() =>
    readPlacePack(INDEX_URL(), fetchImpl),
  );
  const index = await loadTileIndex();
  const keys = tileKeysAround(
    latitude,
    longitude,
    Math.min(radiusKm, PLACE_TILE_KM),
  ).filter((key) => index.tiles[key]);
  // A tile that cannot be read is left out: the places of the others,
  // and the cities, are still the answer.
  const settled = await Promise.allSettled(
    keys.map((key) => {
      let load = tiles.get(key);
      if (load) tiles.delete(key);
      else
        load = createRetryableLoader(async () => {
          const pack = await readPlacePack(TILE_URLS[key](), fetchImpl);
          // A name without a letter ("380") is no name to show.
          return indexCities(pack.rows.filter((row) => NAMED.test(row[0])));
        });
      // Most recently used last; the least recently used goes past the cap.
      tiles.set(key, load);
      while (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
      return load();
    }),
  );
  return settled
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);
}

async function readPlacePack(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok)
    throw new Error(`places pack: HTTP ${response.status} for ${url.pathname}`);
  return response.json();
}

/**
 * Named cities and smaller places around one point, nearest first. Smaller
 * places are looked for within PLACE_TILE_KM only.
 */
export async function placesNear(
  { latitude, longitude, radiusKm = 10, limit = 6 },
  fetchImpl = (...args) => globalThis.fetch(...args),
) {
  if (
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(radiusKm) ||
    radiusKm < 0
  )
    return [];
  const radius = Math.min(radiusKm, Math.PI * EARTH_KM);
  const [{ cells }, detail] = await Promise.all([
    loadCities(fetchImpl),
    // Without the pack's index there are still the cities.
    readPlaceTiles(latitude, longitude, radius, fetchImpl).catch(() => []),
  ]);
  // A smaller place that has the name of a city within TWIN_KM in the same
  // country is the same place listed twice (a town and its municipality):
  // the city's row wins. Cities just past the radius count, so a twin
  // inside it is still caught; namesakes across a border both stay.
  const cities = citiesWithin(cells, latitude, longitude, radius + TWIN_KM);
  const byName = new Map();
  for (const city of cities) {
    const key = foldName(city.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(city);
  }
  const twinOfCity = (place) =>
    (byName.get(foldName(place.name)) || []).some(
      (city) =>
        (city.country || '') === (place.country || '') &&
        distanceKm(
          city.latitude,
          city.longitude,
          place.latitude,
          place.longitude,
        ) <= TWIN_KM,
    );
  const found = [
    ...cities.filter((city) => city.distanceKm <= radius),
    ...detail
      .flatMap((source) =>
        citiesWithin(
          source,
          latitude,
          longitude,
          Math.min(radius, PLACE_TILE_KM),
        ),
      )
      .filter((place) => !twinOfCity(place)),
  ];
  const seen = new Set();
  return found
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .filter((place) => !seen.has(place.wikidata) && seen.add(place.wikidata))
    .slice(0, limit);
}

/** How near two places of one name in one country are taken as one, in km. */
const TWIN_KM = 3;

/**
 * The place with this name, or null. A qualifier after a comma that names a
 * country ("Paris, France", "Paris, US") keeps only places there, and finds
 * nothing when none is; one that names no country ("Paris, Texas") is
 * ignored. A place of that name within `radiusKm` of `near` (the view) wins,
 * the nearest first, else the largest city of that name anywhere. With
 * `includeSmallPlaces`, the smaller places of the detail tiles near the view
 * count too: a village in view comes before a far bigger city of its name.
 */
export async function findPlace(
  name,
  { near = null, radiusKm = 150, includeSmallPlaces = false } = {},
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
  if (Number.isFinite(near?.latitude) && Number.isFinite(near?.longitude)) {
    let best = null;
    for (const row of cities) {
      const km = distanceKm(near.latitude, near.longitude, row[1], row[2]);
      if (km <= radiusKm && (!best || km < best.distanceKm))
        best = toCity(row, km);
    }
    if (includeSmallPlaces) {
      const nearby = await placesNear(
        {
          latitude: near.latitude,
          longitude: near.longitude,
          radiusKm,
          limit: Infinity,
        },
        fetchImpl,
      );
      const small = nearby.find(
        (place) =>
          foldName(place.name) === wanted &&
          (!country || place.country === country),
      );
      if (small && (!best || small.distanceKm < best.distanceKm)) best = small;
    }
    if (best) return best;
  }
  return cities.length ? toCity(cities[0], 0) : null;
}
