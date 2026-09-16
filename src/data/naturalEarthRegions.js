/**
 * Natural Earth physical-regions lookup — offline polygons for named natural
 * regions (mountain ranges, deserts, plateaus, peninsulas, islands) and marine
 * areas (seas, gulfs, straits, bays), so voice asks like "outline the Alps"
 * resolve to REAL region geometry instead of failing or matching a tiny meadow.
 *
 * Data: `local_data/natural_earth/{regions,marine}.json` — curated from the
 * Natural Earth 10m physical vectors (public domain; see each file's `meta`
 * header and DATA_SOURCES.md). Curation kept named features only, outer rings
 * only, Douglas-Peucker simplified (~0.01°) with coords rounded to 3 decimals.
 *
 * PURE data module — no Cesium imports, node-testable. The packs are lazy-
 * loaded on first lookup and cached in module scope (bbox/area computed once
 * at load). In the browser Vite bundles the JSON via dynamic import; under
 * node the same files are read from disk. A failed load is retried on the
 * next lookup rather than cached (see `createRetryableLoader`).
 */

import { createRetryableLoader } from './retryableLoad.js';

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/**
 * Spherical-excess ring area (km²) — same family as turf/geojson-area.
 * @param {Array<[number, number]>} ring outer ring as [lon, lat] pairs in
 *   decimal degrees (GeoJSON order).
 * @returns {number} unsigned enclosed area in square kilometers.
 */
function ringAreaKm2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    sum += toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

/**
 * Great-circle separation on a sphere — used only for bbox diagonals and
 * relative ranking, never for display distances.
 * @param {number} lon1 first longitude, decimal degrees.
 * @param {number} lat1 first latitude, decimal degrees.
 * @param {number} lon2 second longitude, decimal degrees.
 * @param {number} lat2 second latitude, decimal degrees.
 * @returns {number} separation in kilometers.
 */
function haversineKm(lon1, lat1, lon2, lat2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Normalize a query/name for matching: lowercase, strip diacritics and
 * punctuation, collapse whitespace, strip a leading "the ".
 * @param {string} s raw name or spoken query.
 * @returns {string} canonical match key ('' for an empty input).
 */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/\p{M}/gu, '')
    .replaceAll(/[^a-z0-9 ]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/**
 * Common spoken aliases → the pack's canonical (normalized) names.
 * Keys and values are both in normalizeName() form.
 */
const ALIASES = {
  'rockies': 'rocky mountains',
  'himalaya': 'himalayas',
  'the himalaya': 'himalayas',
  'alps mountains': 'alps',
  'sahara desert': 'sahara',
  'gobi': 'gobi desert',
  'kalahari': 'kalahari desert',
  'atacama': 'desierto de atacama',
  'atacama desert': 'desierto de atacama',
  'tibetan plateau': 'plateau of tibet',
  'tibet plateau': 'plateau of tibet',
  'appalachians': 'appalachian mts',
  'appalachian mountains': 'appalachian mts',
  'caucasus': 'caucasus mts',
  'caucasus mountains': 'caucasus mts',
  'balkans': 'balkan pen',
  'balkan peninsula': 'balkan pen',
  'andes mountains': 'andes',
  'urals': 'ural mountains',
  'pyrenees mountains': 'pyrenees',
  'arabian gulf': 'persian gulf',
  'gulf of arabia': 'persian gulf',
  'mediterranean': 'mediterranean sea',
  'caribbean': 'caribbean sea',
  'baja': 'baja california',
  'yucatan': 'pen de yucatan',
  'yucatan peninsula': 'pen de yucatan',
  'kamchatka': 'kamchatka peninsula',
  'sierra nevada mountains': 'sierra nevada',
};

/**
 * Generic suffix rewrites tried when there is no exact/alias hit.
 * @param {string} norm normalized query (normalizeName form).
 * @returns {string[]} alternate keys to try, most specific first.
 */
function suffixVariants(norm) {
  const v = [];
  // "x mountains" ↔ "x mts" (pack uses "Mts."; normalization strips the dot)
  if (norm.endsWith(' mountains')) v.push(norm.replace(/ mountains$/, ' mts'), norm.replace(/ mountains$/, ''));
  if (norm.endsWith(' mts')) v.push(norm.replace(/ mts$/, ' mountains'), norm.replace(/ mts$/, ''));
  // "x desert" ↔ "x"
  if (norm.endsWith(' desert')) v.push(norm.replace(/ desert$/, ''));
  else v.push(`${norm  } desert`);
  // "x peninsula" ↔ "x pen" (pack uses "Pen.")
  if (norm.endsWith(' peninsula')) v.push(norm.replace(/ peninsula$/, ' pen'));
  if (norm.endsWith(' pen')) v.push(norm.replace(/ pen$/, ' peninsula'));
  // "x range" → "x"
  if (norm.endsWith(' range')) v.push(norm.replace(/ range$/, ''));
  return v;
}

/** @type {Array|null} flat entry list for listRegions() */
let _entries = null;

const isNode = typeof process !== 'undefined' && Boolean(process.versions?.node)
  && typeof window === 'undefined';

/**
 * Load one bundled Natural Earth pack by its base name.
 * @param {'regions'|'marine'} base pack selector.
 * @returns {Promise<object>} the raw pack (GeoJSON-ish, pre-decimated, with
 *   `features[].polygons` instead of full geometry).
 */
async function loadPackFile(base) {
  if (isNode) {
    // Import attribute instead of node:fs readFileSync — a plain dynamic JSON
    // import needs one in Node, and keeping node:fs out of this module keeps
    // it out of the browser bundle's externalization warnings (upstream
    // issue #34 / PR #112).
    // Concatenation, deliberately not a template literal: Vite statically
    // expands `new URL(`…${x}.json`, import.meta.url)` and emits EVERY match
    // as a hashed asset — ~2.6 MB of regions/marine JSON shipped beside the
    // JS-module twins the browser actually loads. This branch never runs in
    // a browser, so the URL only has to resolve under Node.
    // eslint-disable-next-line prefer-template -- a template literal is statically expandable, and Vite would re-emit every matching JSON as a dead hashed asset in dist
    const spec = './local_data/natural_earth/' + base + '.json';
    const url = new URL(spec, import.meta.url);
    const mod = await import(/* @vite-ignore */ url.href, { with: { type: 'json' } });
    return mod.default || mod;
  }
  // Vite bundles these JSON files as modules (same pattern as neighborhoodPolygons.js)
  const mod = base === 'regions'
    ? await import('./local_data/natural_earth/regions.json')
    : await import('./local_data/natural_earth/marine.json');
  return mod.default || mod;
}

/**
 * Flatten a pack into indexed entries, computing the area/bbox metrics that
 * ranking needs once at load time.
 * @param {object} pack loaded pack from loadPackFile.
 * @param {'natural'|'marine'} kind discriminator stamped on every entry.
 * @returns {Array<object>} entries with polygons, areaKm2, bbox and diagonal.
 */
function buildEntries(pack, kind) {
  const out = [];
  for (const ft of pack.features || []) {
    const polygons = ft.polygons || [];
    if (!polygons.length) continue;
    let areaKm2 = 0;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const ring of polygons) {
      areaKm2 += ringAreaKm2(ring);
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    out.push({
      name: ft.name,
      namealt: ft.namealt || null,
      featurecla: ft.featurecla || '',
      kind,
      polygons,
      areaKm2,
      bbox: [minLon, minLat, maxLon, maxLat],
      bboxDiagonalKm: haversineKm(minLon, minLat, maxLon, maxLat),
    });
  }
  return out;
}

/**
 * Load + index both packs, once. A failure is NOT memoized: callers
 * `.catch(() => null)` and would otherwise report a broken pack to the user
 * as "no such region" for the rest of the session.
 */
const loadIndex = createRetryableLoader(async () => {
  const [regions, marine] = await Promise.all([
    loadPackFile('regions'),
    loadPackFile('marine'),
  ]);
  _entries = [
    ...buildEntries(regions, 'natural'),
    ...buildEntries(marine, 'marine'),
  ];
  const index = new Map();
  for (const entry of _entries) {
    for (const key of new Set([normalizeName(entry.name), normalizeName(entry.namealt)])) {
      if (!key) continue;
      const list = index.get(key);
      if (list) list.push(entry); else index.set(key, [entry]);
    }
  }
  // duplicate names exist in Natural Earth (e.g. two "Cordillera Oriental",
  // a sliver + real "Canadian Shield") — prefer the largest-area match
  for (const list of index.values()) list.sort((a, b) => b.areaKm2 - a.areaKm2);
  return index;
});

/**
 * Project an internal entry onto the public result shape (drops internals).
 * @param {object} entry an index entry from buildEntries.
 * @returns {object} public result: name, classification, kind, geometry,
 *   bbox and metrics.
 */
function toResult(entry) {
  return {
    name: entry.name,
    featurecla: entry.featurecla,
    kind: entry.kind,
    polygons: entry.polygons,
    bbox: entry.bbox,
    bboxDiagonalKm: entry.bboxDiagonalKm,
    areaKm2: entry.areaKm2,
  };
}

/**
 * Look up a named natural/marine region.
 * Case-insensitive; strips "the"; resolves common aliases ("Rockies" →
 * "Rocky Mountains", "Sahara Desert" → "Sahara") and generic suffix variants
 * ("X Mountains" ↔ "X Mts.", "X Peninsula" ↔ "X Pen.").
 *
 * @param {string} query e.g. "the Alps", "Rockies", "Gulf of Mexico"
 * @returns {Promise<{name:string, featurecla:string, kind:'natural'|'marine',
 *   polygons:Array<Array<[number,number]>>, bbox:[number,number,number,number],
 *   bboxDiagonalKm:number, areaKm2:number}|null>} largest-area match (bbox is
 *   [minLon, minLat, maxLon, maxLat]), or null when nothing matches.
 */
export async function findNaturalRegion(query) {
  const norm = normalizeName(query);
  if (!norm) return null;
  const index = await loadIndex();
  const candidates = [norm, ALIASES[norm], ...suffixVariants(ALIASES[norm] || norm)];
  for (const key of candidates) {
    if (!key) continue;
    const list = index.get(key);
    if (list && list.length) return toResult(list[0]);
  }
  return null;
}

/**
 * Diagnostics: every region in the pack (no geometry).
 * @returns {Promise<Array<{name:string, featurecla:string, kind:string, areaKm2:number, bboxDiagonalKm:number}>>}
 *   one row per pack entry, no geometry.
 */
export async function listRegions() {
  await loadIndex();
  return _entries.map((e) => ({
    name: e.name,
    featurecla: e.featurecla,
    kind: e.kind,
    areaKm2: e.areaKm2,
    bboxDiagonalKm: e.bboxDiagonalKm,
  }));
}

/**
 * Ray-cast (even-odd) point-in-ring test. Ring = [[lon,lat], …], open or
 * closed. Degenerate rings (<3 verts) are never containing.
 * @param {Array<[number,number]>} ring candidate ring, [lon, lat] pairs in
 *   decimal degrees.
 * @param {number} lat test latitude, decimal degrees.
 * @param {number} lon test longitude, decimal degrees.
 * @returns {boolean} true when the point is inside the ring.
 */
export function pointInRing(ring, lat, lon) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > lat) !== (yj > lat)
      && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Resolve a natural-region OUTLINE ring for the annotation resolver's first
 * rung. Stricter than `findNaturalRegion`: walks ALL entries sharing the
 * matched name (duplicate names included — the US and Spanish "Sierra
 * Nevada" both exist upstream) and returns the single ring that CONTAINS the
 * geocoded anchor. Containment is simultaneously the disambiguator and the
 * wrong-place guard: when no ring contains the anchor this returns null and
 * the resolver's normal ladder continues unchanged.
 *
 * @param {string} query   The user's place ask (aliases/articles handled).
 * @param {number} lat     Geocoded anchor latitude.
 * @param {number} lon     Geocoded anchor longitude.
 * @returns {Promise<{name:string, kind:'natural'|'marine', featurecla:string,
 *   ring:Array<[number,number]>, areaKm2:number}|null>} the containing ring,
 *   or null when no candidate ring holds the anchor.
 */
export async function lookupNaturalRegionOutline(query, lat, lon) {
  const norm = normalizeName(query);
  if (!norm || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const index = await loadIndex();
  const candidates = [norm, ALIASES[norm], ...suffixVariants(ALIASES[norm] || norm)];
  const seen = new Set();
  for (const key of candidates) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    for (const entry of index.get(key) || []) {
      for (const ring of entry.polygons) {
        if (pointInRing(ring, lat, lon)) {
          return {
            name: entry.name,
            kind: entry.kind,
            featurecla: entry.featurecla,
            ring,
            areaKm2: entry.areaKm2,
          };
        }
      }
    }
  }
  return null;
}
