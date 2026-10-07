/**
 * Bundled place and neighborhood outlines — US Census Bureau places (cities,
 * towns, CDPs) and Who's On First neighborhoods — so "outline Austin" or
 * "outline Notting Hill" draws a real boundary without a network lookup.
 *
 * Data: `local_data/us_census_places/` (one file per state, public domain,
 * `scripts/build-census-places.mjs`) and `local_data/wof_neighborhoods/`
 * (quadtree tiles, per-source licences, `scripts/build-wof-neighborhoods.py`).
 * Provenance is in each folder's README.
 *
 * PURE data module — no Cesium, node-testable. The packs are not fetched at
 * app start: an ask fetches the small index, then only the state files or
 * tiles near the point it is about. (The bundler inlines files under its
 * asset-inline limit, 4 KB, into the app bundle; the rest are separate
 * assets.) Loads are memoized, the recently used state files and tiles kept
 * up to a fixed count; a failed load is retried later
 * (`createRetryableLoader`).
 *
 * Entry points:
 *   - `findPlaceArea(query, { near, nearKm, stateHint })` — a US place from
 *     its name. A state qualifier ("Springfield, Illinois") narrows the
 *     search to that state; the camera (a place containing or within
 *     `nearKm` of the view) narrows it further. "City of X" asks for an
 *     incorporated place, "X CDP" for a census designated place. When more
 *     than one place still fits and neither containment, incorporation nor a
 *     clearly nearest candidate decides, it returns null (the geocoder's).
 *   - `findPlaceAreaAt(names, lat, lon)` — geocoder-confirmed: a place that
 *     carries one of the names AND contains the point.
 *   - `findNeighborhoodArea(query, { near })` and
 *     `findNeighborhoodAreaAt(names, lat, lon)` — the same for WOF
 *     neighborhoods (the San Francisco DataSF pack is consulted first by the
 *     resolver, not here).
 *
 * Results have the `AdminArea` shape of `adminBoundaries.js`, with
 * kind 'place' (source 'us-census') or 'neighborhood' (source 'wof').
 */

import {
  boxDistanceKm,
  geometryOf,
  polygonsContain,
  rank,
} from './adminBoundaries.js';
import { loadBundledJson } from './bundledJson.js';
import { createRetryableLoader } from './retryableLoad.js';
import * as placeFiles from './local_data/us_census_places/files.js';
import * as neighborhoodFiles from './local_data/wof_neighborhoods/files.js';

/** Default reach of a bare place name around the view (see `nearKm`). */
export const PLACE_NEAR_KM = 60;
/** Default reach of a neighborhood name around the view. */
export const NEIGHBORHOOD_NEAR_KM = 20;
/** Loaded state files and neighborhood tiles kept, most recently used. */
export const CACHE_LIMITS = { states: 12, tiles: 24 };
/** A geocoded neighborhood point may sit this far outside the outline. */
const NEIGHBORHOOD_AT_KM = 1.5;

/** Test seam: count index, state and tile loads (lazy-loading contract). */
export const packLoads = {
  placeIndex: 0,
  placeStates: [],
  neighborhoodIndex: 0,
  neighborhoodTiles: [],
};

const FOLD = {
  ß: 'ss',
  ø: 'o',
  æ: 'ae',
  ł: 'l',
  đ: 'd',
  ı: 'i',
  œ: 'oe',
  þ: 'th',
};

/**
 * A name as spelled: case and punctuation only. Every mark is kept, so
 * "की" and "क", "Й" and "И" stay distinct.
 */
export function exactPlaceName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Fold a name for matching: case, punctuation, accents on Latin letters
 * only, a leading "the", "saint". Other scripts keep their marks
 * ("渋谷", "Кунцево", "बांद्रा").
 */
export function normalizePlaceName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ßøæłđıœþ]/g, (c) => FOLD[c])
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bsainte\b/g, 'ste');
}

/** Index keys of a name: as spelled (`=`-prefixed), then folded. */
function nameVariants(value) {
  return ['=' + exactPlaceName(value), normalizePlaceName(value)];
}

const ARTICLE = /^(?:le|la|les|l|el|los|las|il|lo|der|die|das|de|het) /;
const GENERIC_SUFFIX =
  / (?:district|neighborhood|neighbourhood|area|quarter|barrio|quartier)$/;

const PLACE_TYPE_PREFIX = /^(city|town|village|borough) of /i;

/**
 * Split an ask into the name, the place type it asks for, and its comma
 * qualifiers.
 * @param {string} text e.g. "Springfield, Illinois", "City of Burbank"
 * @returns {{name:string, exact:string, type:string|null,
 *   qualifiers:string[], raw:string}|null}
 */
export function parsePlaceQuery(text) {
  const raw = String(text || '').trim();
  const [first = '', ...rest] = raw.split(',');
  let head = first.trim().replace(/\s+limits$/i, '');
  let type = null;
  const prefix = PLACE_TYPE_PREFIX.exec(head);
  if (prefix) {
    type = prefix[1].toLowerCase();
    head = head.slice(prefix[0].length);
  } else if (/\s+cdp$/i.test(head)) {
    type = 'cdp';
    head = head.replace(/\s+cdp$/i, '');
  }
  const name = normalizePlaceName(head);
  if (!name) return null;
  return {
    name,
    exact: exactPlaceName(head),
    type,
    qualifiers: rest.map(normalizePlaceName).filter(Boolean),
    raw,
  };
}

const UNITED_STATES = new Set([
  'us',
  'u s',
  'usa',
  'u s a',
  'united states',
  'united states of america',
  'america',
]);

// ── loading ─────────────────────────────────────────────────────────────

const loadPlaceIndex = createRetryableLoader(async () => {
  packLoads.placeIndex += 1;
  const index = await loadBundledJson(placeFiles.INDEX_URL());
  const states = index.states.map((state) => ({
    ...state,
    key: normalizePlaceName(state.name),
    code: state.st.toLowerCase(),
  }));
  return { meta: index.meta, states };
});

/**
 * Memoized loaders keyed by file, keeping at most `limit()` loaded ones
 * (least recently used go first). An in-flight or failed loader stays, so
 * concurrent asks share one fetch and a failure keeps its retry cooldown.
 */
function boundedLoaders(limit) {
  const entries = new Map();
  function trim() {
    let loaded = 0;
    for (const entry of entries.values()) if (entry.loaded) loaded += 1;
    for (const [key, entry] of entries) {
      if (loaded <= limit()) break;
      if (!entry.loaded) continue;
      entries.delete(key);
      loaded -= 1;
    }
  }
  return {
    load(key, make) {
      let entry = entries.get(key);
      if (entry) entries.delete(key);
      else entry = { loader: make(), loaded: false };
      entries.set(key, entry);
      const pending = entry.loader();
      pending.then(
        () => {
          entry.loaded = true;
          trim();
        },
        () => {},
      );
      return pending;
    },
    loadedKeys: () =>
      [...entries].filter(([, e]) => e.loaded).map(([key]) => key),
  };
}

const stateLoaders = boundedLoaders(() => CACHE_LIMITS.states);

/** Test seam: the state files and tiles currently kept. */
export function cachedPackFiles() {
  return {
    states: stateLoaders.loadedKeys(),
    tiles: tileLoaders.loadedKeys(),
  };
}

/** Builds a pack file URL on use (never at import); unknown keys fail loudly. */
function packUrl(urls, key) {
  const build = urls[key];
  if (typeof build !== 'function')
    throw new Error(`No bundled boundary file for ${key}`);
  return build();
}

function loadState(st) {
  return stateLoaders.load(st, () =>
    createRetryableLoader(async () => {
      packLoads.placeStates.push(st);
      const [{ meta }, pack] = await Promise.all([
        loadPlaceIndex(),
        loadBundledJson(packUrl(placeFiles.STATE_URLS, st)),
      ]);
      const byKey = new Map();
      for (const feature of pack.features) {
        const entry = {
          kind: 'place',
          feature,
          decimals: meta.decimals,
          state: pack.state,
          st: pack.st,
        };
        for (const key of nameVariants(feature.name))
          addKey(byKey, key, entry, 0, null);
        for (const alt of feature.alt || [])
          for (const key of nameVariants(alt))
            addKey(byKey, key, entry, 1, alt);
        for (const key of nameVariants(feature.full))
          addKey(byKey, key, entry, 2, null);
      }
      return byKey;
    }),
  );
}

/** The neighborhood index once loaded, for the synchronous no-tile answer. */
let neighborhoodIndex = null;

const loadNeighborhoodIndex = createRetryableLoader(async () => {
  packLoads.neighborhoodIndex += 1;
  neighborhoodIndex = await loadBundledJson(neighborhoodFiles.INDEX_URL());
  return neighborhoodIndex;
});

const tileLoaders = boundedLoaders(() => CACHE_LIMITS.tiles);

function loadTile(key) {
  return tileLoaders.load(key, () =>
    createRetryableLoader(async () => {
      packLoads.neighborhoodTiles.push(key);
      const [index, tile] = await Promise.all([
        loadNeighborhoodIndex(),
        loadBundledJson(packUrl(neighborhoodFiles.TILE_URLS, `t${key}`)),
      ]);
      const precision = index.meta.precision;
      const byKey = new Map();
      for (const feature of tile.features) {
        const [id, name, country, type, bbox, aliases, source, rings, label] =
          feature;
        const entry = {
          kind: 'neighborhood',
          feature: { id, name, country, type, bbox, source, label },
          decode: () =>
            rings.map((poly) =>
              poly.map((ring) => decodePolyline(ring, precision)),
            ),
        };
        for (const key of nameVariants(name)) {
          addKey(byKey, key, entry, 0, null);
          addKey(byKey, key.replace(ARTICLE, ''), entry, 1, null);
        }
        for (const alias of aliases)
          for (const key of nameVariants(alias)) {
            addKey(byKey, key, entry, 2, null);
            addKey(byKey, key.replace(ARTICLE, ''), entry, 2, null);
          }
      }
      return byKey;
    }),
  );
}

function addKey(index, key, entry, tier, alias) {
  if (!key) return;
  const list = index.get(key);
  const item = { entry, tier, alias };
  if (!list) index.set(key, [item]);
  else {
    const existing = list.find((i) => i.entry === entry);
    if (!existing) list.push(item);
    else if (tier < existing.tier) Object.assign(existing, item);
  }
}

/**
 * Decode one encoded polyline ring: zigzag varint deltas in 5-bit groups
 * offset by 63, longitude then latitude, at 10^-precision degrees.
 * @param {string} encoded
 * @param {number} [precision]
 * @returns {Array<[number, number]>} ring of [lon, lat]
 */
export function decodePolyline(encoded, precision = 5) {
  const factor = 10 ** precision;
  const ring = [];
  const last = [0, 0];
  let axis = 0;
  let i = 0;
  while (i < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(i++) - 63;
      result += (byte & 31) * 2 ** shift;
      shift += 5;
    } while (byte >= 32 && i < encoded.length);
    const delta = result % 2 ? -(result + 1) / 2 : result / 2;
    last[axis] += delta;
    if (axis === 1) ring.push([last[0] / factor, last[1] / factor]);
    axis ^= 1;
  }
  return ring;
}

// ── lookups ─────────────────────────────────────────────────────────────

function hasPoint(near) {
  return Number.isFinite(near?.lat) && Number.isFinite(near?.lon);
}

/** Place states named by the qualifiers; null when one names somewhere else. */
function qualifierStates(qualifiers, states) {
  const out = [];
  for (const q of qualifiers) {
    const state = states.find((s) => s.key === q || s.code === q);
    if (state) out.push(state);
    else if (!UNITED_STATES.has(q)) return null;
  }
  return out;
}

/** "Austin Texas", "Austin TX": a trailing state name without a comma. */
function splitTrailingState(parsed, states) {
  if (parsed.qualifiers.length) return parsed;
  const words = parsed.name.split(' ');
  for (let k = Math.min(3, words.length - 1); k >= 1; k--) {
    const tail = words.slice(-k).join(' ');
    const upperCode =
      k === 1 && new RegExp(`\\b${tail}$`, 'i').test(parsed.raw)
        ? /\b([A-Z]{2})\s*$/.exec(parsed.raw)?.[1]?.toLowerCase()
        : null;
    if (states.some((s) => s.key === tail) || (upperCode && upperCode === tail))
      return {
        ...parsed,
        name: words.slice(0, -k).join(' '),
        qualifiers: [tail],
      };
  }
  return parsed;
}

function placeResult(scored, candidateCount) {
  const { entry, alias } = scored;
  const geometry = geometryOf(entry);
  const { feature } = entry;
  return {
    kind: 'place',
    name: alias || feature.name,
    fullName: feature.full,
    type: feature.lsad || null,
    region: entry.state,
    regionCode: entry.st,
    country: 'United States of America',
    id: feature.geoid,
    source: 'us-census',
    polygons: geometry.polygons,
    ring: geometry.polygons[0][0],
    bbox: geometry.bbox,
    areaKm2: geometry.areaKm2,
    label: geometry.label,
    candidates: candidateCount,
  };
}

function neighborhoodResult(scored, candidateCount) {
  const { entry } = scored;
  const geometry = geometryOf(entry);
  const { feature } = entry;
  return {
    kind: 'neighborhood',
    name: feature.name,
    type: feature.type,
    region: null,
    regionCode: null,
    country: feature.country,
    id: String(feature.id),
    source: 'wof',
    geometrySource: feature.source,
    polygons: geometry.polygons,
    ring: geometry.polygons[0][0],
    bbox: geometry.bbox,
    areaKm2: geometry.areaKm2,
    label: geometry.label,
    candidates: candidateCount,
    // Matched on an alternate name only (tile aliases index at tier 2).
    byAlias: scored.tier % 10 === 2,
  };
}

/**
 * Candidates for any of `keys` across the loaded name maps, de-duplicated.
 * Keys come in preference order (the spelling as asked first); a match on an
 * earlier key outranks any match on a later one.
 */
function collect(maps, keys) {
  const out = [];
  keys.forEach((key, variant) => {
    for (const byKey of maps)
      for (const item of byKey.get(key) || []) {
        const tier = variant * 10 + item.tier;
        const existing = out.find((c) => c.entry === item.entry);
        if (!existing) out.push({ ...item, tier });
        else if (tier < existing.tier) Object.assign(existing, item, { tier });
      }
  });
  return out;
}

/** Keep only the candidates of the best (lowest) tier. */
function bestTier(candidates) {
  const top = Math.min(...candidates.map((c) => c.tier));
  return candidates.filter((c) => c.tier === top);
}

/** The place type an ask named: "city of" → incorporated, "CDP" → CDP. */
function ofType(candidates, type) {
  if (!type) return candidates;
  if (type === 'cdp') return candidates.filter((c) => c.entry.feature.cdp);
  const incorporated = candidates.filter((c) => !c.entry.feature.cdp);
  const exact = incorporated.filter((c) => c.entry.feature.lsad === type);
  return exact.length ? exact : incorporated;
}

/**
 * One candidate when the context decides: the only one, the only one that
 * holds the view, the only incorporated place, or one clearly nearest the
 * view (less than half the next one's distance). Otherwise null.
 */
function decisive(candidates, point) {
  if (candidates.length === 1) return candidates[0];
  const located = hasPoint(point);
  if (located) {
    const holding = candidates.filter((c) =>
      polygonsContain(geometryOf(c.entry).polygons, point.lat, point.lon),
    );
    if (holding.length === 1) return holding[0];
  }
  const incorporated = candidates.filter((c) => !c.entry.feature.cdp);
  if (incorporated.length === 1) return incorporated[0];
  if (!located) return null;
  const byDistance = candidates
    .map((c) => ({
      c,
      km: boxDistanceKm(geometryOf(c.entry).bbox, point.lat, point.lon),
    }))
    .sort((a, b) => a.km - b.km);
  return byDistance[0].km * 2 < byDistance[1].km ? byDistance[0].c : null;
}

function near(candidate, point, km) {
  const geometry = geometryOf(candidate.entry);
  return (
    polygonsContain(geometry.polygons, point.lat, point.lon) ||
    boxDistanceKm(geometry.bbox, point.lat, point.lon) <= km
  );
}

/**
 * Resolve a US place from the ask's words and the camera.
 *
 * @param {string} query e.g. "Austin", "Austin, TX", "Springfield, Illinois"
 * @param {{near?: {lat:number, lon:number}|null, stateHint?: string|null}} [options]
 *   `near` is the view centre; `stateHint` a state name or USPS code.
 * @returns {Promise<object|null>} an AdminArea-shaped place, or null
 */
export async function findPlaceArea(
  query,
  { near: at = null, nearKm = PLACE_NEAR_KM, stateHint } = {},
) {
  const parsed = parsePlaceQuery(query);
  if (!parsed?.name) return null;
  const { states } = await loadPlaceIndex();
  // "Kansas City Missouri" names a state at the end; "Fort Washington" is a
  // place whose name ends in one. The name as said is tried first.
  const split = splitTrailingState(parsed, states);
  const found = await placeNamed(parsed, states, at, nearKm, stateHint);
  if (found || split === parsed || !split.name) return found;
  return placeNamed(split, states, at, nearKm, stateHint);
}

async function placeNamed(parsed, states, at, nearKm, stateHint) {
  const named = qualifierStates(
    [
      ...parsed.qualifiers,
      ...(stateHint ? [normalizePlaceName(stateHint)] : []),
    ],
    states,
  );
  if (!named) return null;
  const located = hasPoint(at);
  const pool = named.length
    ? named
    : located
      ? states.filter((s) => boxDistanceKm(s.bbox, at.lat, at.lon) <= nearKm)
      : [];
  if (!pool.length) return null;
  const maps = await Promise.all(pool.map((s) => loadState(s.st)));
  let candidates = ofType(
    collect(maps, ['=' + parsed.exact, parsed.name]),
    parsed.type,
  );
  // Without a state, only a place at or near the view answers ("Paris" over
  // Texas is Paris, Texas; over Europe it is the geocoder's).
  if (!named.length) candidates = candidates.filter((c) => near(c, at, nearKm));
  if (!candidates.length) return null;
  const pick = decisive(bestTier(candidates), located ? at : null);
  return pick ? placeResult(pick, candidates.length) : null;
}

/** State files whose box holds the point (within `km`). */
async function statesAround(lat, lon, km) {
  const { states } = await loadPlaceIndex();
  return states.filter((s) => boxDistanceKm(s.bbox, lat, lon) <= km);
}

function nameKeys(names, strip = false) {
  const keys = [];
  for (const name of names || []) {
    const parsed = parsePlaceQuery(name);
    if (!parsed?.name) continue;
    const variants = ['=' + parsed.exact, parsed.name];
    if (strip) {
      const bare = parsed.name.replace(ARTICLE, '');
      const plain = parsed.name.replace(GENERIC_SUFFIX, '');
      variants.push(bare, plain, plain.replace(ARTICLE, ''));
    }
    for (const key of variants) if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Geocoder-confirmed place: carries one of `names` and contains the point.
 * @param {string[]} names the ask and the geocoder's own name for it
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<object|null>}
 */
export async function findPlaceAreaAt(names, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const keys = nameKeys(names);
  if (!keys.length) return null;
  const pool = await statesAround(lat, lon, 1);
  if (!pool.length) return null;
  const maps = await Promise.all(pool.map((s) => loadState(s.st)));
  const found = collect(maps, keys).filter((c) =>
    polygonsContain(geometryOf(c.entry).polygons, lat, lon),
  );
  if (!found.length) return null;
  const top = rank(bestTier(found), { lat, lon })[0];
  return placeResult(
    { ...top, alias: found.find((c) => c.entry === top.entry).alias },
    found.length,
  );
}

function tileKeysAround(index, lat, lon, km) {
  return index.tiles
    .filter((t) => boxDistanceKm(t.bbox, lat, lon) <= km)
    .map((t) => t.key);
}

async function tilesAround(lat, lon, km) {
  const index = await loadNeighborhoodIndex();
  return Promise.all(tileKeysAround(index, lat, lon, km).map(loadTile));
}

/**
 * Resolve a neighborhood from the ask's words and the camera: one carrying
 * the name that contains the view centre or lies near it. An ask with a
 * qualifier ("Williamsburg, Virginia") is left to the geocoder.
 *
 * @param {string} query e.g. "Notting Hill", "the Mission District"
 * @param {{near?: {lat:number, lon:number}|null, nearKm?: number}} [options]
 * @returns {Promise<object|null>}
 */
export async function findNeighborhoodArea(
  query,
  { near: at = null, nearKm = NEIGHBORHOOD_NEAR_KM } = {},
) {
  if (!hasPoint(at)) return null;
  const parsed = parsePlaceQuery(query);
  if (!parsed?.name || parsed.qualifiers.length) return null;
  const maps = await tilesAround(at.lat, at.lon, nearKm);
  const candidates = collect(maps, nameKeys([query], true)).filter((c) =>
    near(c, at, nearKm),
  );
  if (!candidates.length) return null;
  return neighborhoodResult(
    rank(bestTier(candidates), at)[0],
    candidates.length,
  );
}

/**
 * Geocoder-confirmed neighborhood: carries one of `names` and contains the
 * point, or nearly (a label point just outside the outline).
 * @param {string[]} names
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<object|null>}
 */
export function findNeighborhoodAreaAt(names, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    return Promise.resolve(null);
  // Most of the world has no neighborhood tile: answer without waiting.
  if (
    neighborhoodIndex &&
    !tileKeysAround(neighborhoodIndex, lat, lon, NEIGHBORHOOD_AT_KM).length
  )
    return Promise.resolve(null);
  return neighborhoodAt(names, lat, lon);
}

async function neighborhoodAt(names, lat, lon) {
  const keys = nameKeys(names, true);
  if (!keys.length) return null;
  const point = { lat, lon };
  const maps = await tilesAround(lat, lon, NEIGHBORHOOD_AT_KM);
  const found = collect(maps, keys).filter((c) =>
    near(c, point, NEIGHBORHOOD_AT_KM),
  );
  if (!found.length) return null;
  return neighborhoodResult(rank(bestTier(found), point)[0], found.length);
}
