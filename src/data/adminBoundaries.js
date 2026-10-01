/**
 * Bundled administrative boundaries — countries and states/provinces (Natural
 * Earth admin-0/admin-1) and US counties (US Census Bureau cartographic boundaries),
 * so "outline Texas", "outline Bavaria" or "outline Travis County" draws the
 * real boundary without a network lookup.
 *
 * Data: `local_data/natural_earth/{countries,states_provinces}.json` and
 * `local_data/us_census_counties/counties.json`, public domain and built
 * by `scripts/build-admin-packs.mjs` (provenance in each folder's README).
 * Rings are delta-encoded integers; see `decodeRing`.
 *
 * PURE data module — no Cesium, node-testable. Each pack is fetched through
 * `loadBundledJson` on the first lookup that needs it (never at app start),
 * indexed once, and kept; a failed load is retried later rather than cached
 * (`createRetryableLoader`). The county pack is only loaded for asks that
 * name a county (or a county-equivalent city) or that a geocoder typed as one.
 *
 * Two entry points:
 *   - `findAdminArea(query, { near })` — name-only. Resolves asks that are
 *     unambiguous from the words alone ("Texas", "TX", "State of Texas",
 *     "Bavaria", "Travis County, Texas", "Orleans Parish"); duplicates are
 *     settled by a state/country qualifier, then by the camera (`near`).
 *     Country/state homonyms such as Georgia use the qualifier or camera;
 *     city/state homonyms such as New York still defer to the geocoder.
 *   - `findAdminAreaAt(names, lat, lon, scope)` — geocoder-confirmed. The
 *     geocoder already typed the place as a country, state or county; the unit must
 *     carry one of the names AND contain the geocoded point.
 */

import { loadBundledJson } from './bundledJson.js';
import { createRetryableLoader } from './retryableLoad.js';

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

/** Fold a name for matching: case, accents, punctuation, "the", "saint". */
export function normalizeAdminName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[ßøæłđıœþ]/g, (c) => FOLD[c])
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bsainte\b/g, 'ste');
}

const PACKS = {
  countries: {
    url: new URL('./local_data/natural_earth/countries.json', import.meta.url),
    importJson: () =>
      import('./local_data/natural_earth/countries.json', {
        with: { type: 'json' },
      }),
  },
  admin1: {
    url: new URL(
      './local_data/natural_earth/states_provinces.json',
      import.meta.url,
    ),
    importJson: () =>
      import('./local_data/natural_earth/states_provinces.json', {
        with: { type: 'json' },
      }),
  },
  counties: {
    url: new URL(
      './local_data/us_census_counties/counties.json',
      import.meta.url,
    ),
    importJson: () =>
      import('./local_data/us_census_counties/counties.json', {
        with: { type: 'json' },
      }),
  },
};

/** Test seam: count pack loads (lazy-loading contract). */
export const packLoads = { admin1: 0, counties: 0, countries: 0 };

const EARTH_RADIUS_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

/** Spherical ring area (km²) — same formula as naturalEarthRegions.js. */
function ringAreaKm2(ring) {
  const n = ring.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % n];
    sum +=
      toRad(lon2 - lon1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs((sum * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Decode one packed ring: integers in units of 10^-decimals degrees, the
 * first vertex absolute and each later one a delta from the previous.
 * @param {number[]} encoded
 * @param {number} decimals
 * @returns {Array<[number, number]>} open ring of [lon, lat]
 */
export function decodeRing(encoded, decimals) {
  const factor = 10 ** decimals;
  const ring = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    x += encoded[i];
    y += encoded[i + 1];
    ring.push([x / factor, y / factor]);
  }
  return ring;
}

/** Even-odd point-in-ring test; ring is [[lon, lat], …], open or closed. */
export function pointInRing(ring, lat, lon) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Whether polygons ([outer, ...holes][]) contain the point: inside an outer
 * ring and not inside any of that part's holes.
 */
export function polygonsContain(polygons, lat, lon) {
  for (const [outer, ...holes] of polygons || []) {
    if (!pointInRing(outer, lat, lon)) continue;
    if (!holes.some((hole) => pointInRing(hole, lat, lon))) return true;
  }
  return false;
}

/**
 * A unit's geometry, decoded on first use. Longitudes are unwrapped around
 * the largest part for the box so units cut at the antimeridian (Alaska,
 * Chukotka) get a box on the right side of the globe.
 */
function geometryOf(entry) {
  if (entry.geometry) return entry.geometry;
  const decimals = entry.feature.d ?? entry.decimals;
  const polygons = entry.feature.polygons.map((poly) =>
    poly.map((ring) => decodeRing(ring, decimals)),
  );
  const ref = polygons[0]?.[0]?.[0]?.[0] ?? 0;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let areaKm2 = 0;
  for (const [outer, ...holes] of polygons) {
    areaKm2 += ringAreaKm2(outer);
    for (const hole of holes) areaKm2 -= ringAreaKm2(hole);
    for (const [lon, lat] of outer) {
      const x = lon - 360 * Math.round((lon - ref) / 360);
      if (x < west) west = x;
      if (x > east) east = x;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  const label = entry.feature.label
    ? { lon: entry.feature.label[0], lat: entry.feature.label[1] }
    : ringCentroid(polygons[0][0]);
  entry.geometry = {
    polygons,
    bbox: [west, south, east, north],
    areaKm2: Math.max(0, areaKm2),
    label,
  };
  return entry.geometry;
}

/** Area-weighted centroid of an open ring (planar; fine at unit scale). */
function ringCentroid(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j];
    const [x1, y1] = ring[i];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (!a) return { lon: ring[0][0], lat: ring[0][1] };
  return { lon: cx / (3 * a), lat: cy / (3 * a) };
}

/** Km from a point to a unit's box (0 inside it). */
function boxDistanceKm(bbox, lat, lon) {
  const [west, south, east, north] = bbox;
  const mid = (west + east) / 2;
  const x = lon - 360 * Math.round((lon - mid) / 360);
  const clampedLon = Math.min(east, Math.max(west, x));
  const clampedLat = Math.min(north, Math.max(south, lat));
  return haversineKm(lat, x, clampedLat, clampedLon);
}

/**
 * Natural Earth `min_label` (the zoom at which a unit is labelled) up to which
 * a unit may be named alone: every US state, Canadian province, Mexican and
 * German state; not English counties, French départements or small districts.
 */
const BARE_NAME_MAX_RANK = 7;

/**
 * Words that name a unit somewhere (Cameroon's "North", Paraguay's
 * "Central") but, said alone, name a direction or a feature.
 */
const GENERIC_NAMES = new Set([
  'north',
  'south',
  'east',
  'west',
  'northern',
  'southern',
  'eastern',
  'western',
  'north east',
  'north west',
  'south east',
  'south west',
  'northeast',
  'northwest',
  'southeast',
  'southwest',
  'far north',
  'far west',
  'central',
  'centre',
  'center',
  'capital',
  'coast',
  'island',
  'islands',
  'lakes',
  'highland',
  'highlands',
  'interior',
  'upper',
  'lower',
  'valley',
  'plateau',
  'plateaux',
  'littoral',
  'oriental',
  'occidental',
]);

/** State codes that, alone, more often mean a city ("LA", "NY"). */
const CITY_ABBREVIATIONS = new Set(['la', 'ny']);

/** Postal abbreviations accepted alone ("TX", "ON"): US states and Canada. */
const POSTAL_COUNTRIES = new Set(['US', 'CA']);

function addKey(index, key, entry, tier) {
  if (!key) return;
  entry.keys?.add(key);
  const list = index.get(key);
  const item = { entry, tier };
  if (!list) index.set(key, [item]);
  else if (!list.some((i) => i.entry === entry)) list.push(item);
}

const loadAdmin1 = createRetryableLoader(async () => {
  packLoads.admin1 += 1;
  const pack = await loadBundledJson(PACKS.admin1.url, PACKS.admin1.importJson);
  const decimals = pack.meta?.decimals ?? 3;
  const index = new Map();
  for (const feature of pack.features || []) {
    const entry = {
      kind: 'state',
      feature,
      decimals,
      amb: new Set(feature.amb || []),
      ambAbroad: new Set(feature.ambAbroad || []),
      keys: new Set(),
      country: normalizeAdminName(feature.country),
      iso2: String(feature.iso2 || '').toLowerCase(),
    };
    addKey(index, normalizeAdminName(feature.name), entry, 0);
    addKey(index, normalizeAdminName(feature.nameEn), entry, 1);
    for (const alt of feature.alt || [])
      addKey(index, normalizeAdminName(alt), entry, 2);
    if (feature.postal && POSTAL_COUNTRIES.has(feature.iso2))
      addKey(index, `postal:${feature.postal.toLowerCase()}`, entry, 2);
  }
  return { index };
});

const loadCounties = createRetryableLoader(async () => {
  packLoads.counties += 1;
  const pack = await loadBundledJson(
    PACKS.counties.url,
    PACKS.counties.importJson,
  );
  const decimals = pack.meta?.decimals ?? 4;
  const byFull = new Map();
  const byName = new Map();
  const states = new Map();
  for (const feature of pack.features || []) {
    const entry = {
      kind: 'county',
      feature,
      decimals,
      state: normalizeAdminName(feature.state),
      st: String(feature.st || '').toLowerCase(),
    };
    addKey(byFull, normalizeAdminName(feature.full), entry, 0);
    addKey(byName, normalizeAdminName(feature.name), entry, 1);
    states.set(entry.state, entry.st);
  }
  return { byFull, byName, states };
});

const loadCountries = createRetryableLoader(async () => {
  packLoads.countries += 1;
  const pack = await loadBundledJson(
    PACKS.countries.url,
    PACKS.countries.importJson,
  );
  const index = new Map();
  for (const feature of pack.features || []) {
    const entry = {
      kind: 'country',
      feature,
      decimals: pack.meta.decimals,
      keys: new Set(),
      country: normalizeAdminName(feature.country),
      iso2: feature.iso2?.toLowerCase(),
    };
    for (const name of [feature.name, ...(feature.alt || [])])
      addKey(index, normalizeAdminName(name), entry, 0);
  }
  return { index };
});

async function countryCandidates(parsed) {
  if (!['any', 'country'].includes(parsed.kind)) return [];
  const { index } = await loadCountries();
  const key = COUNTRY_TARGET_ALIASES.get(parsed.name) || parsed.name;
  return (index.get(key) || []).filter(({ entry }) =>
    parsed.qualifiers.every((q) => qualifierMatches(entry, q)),
  );
}

/** Country target aliases never broaden constituent-country requests. */
const COUNTRY_TARGET_ALIASES = new Map([
  ['usa', 'united states of america'],
  ['us', 'united states of america'],
  ['u s', 'united states of america'],
  ['u s a', 'united states of america'],
  ['united states', 'united states of america'],
  ['america', 'united states of america'],
  ['uk', 'united kingdom'],
  ['u k', 'united kingdom'],
  ['great britain', 'united kingdom'],
  ['britain', 'united kingdom'],
  ['russian federation', 'russia'],
  ['korea', 'south korea'],
  ['czechia', 'czech republic'],
  ['tanzania', 'united republic of tanzania'],
  ['drc', 'democratic republic of the congo'],
]);

const COUNTRY_ALIASES = new Map([
  ...COUNTRY_TARGET_ALIASES,
  ['england', 'united kingdom'],
  ['scotland', 'united kingdom'],
  ['wales', 'united kingdom'],
  ['northern ireland', 'united kingdom'],
]);

/** County-equivalent words, longest first so "city and borough" wins. */
const COUNTY_WORDS = [
  'city and borough',
  'planning region',
  'census area',
  'municipality',
  'municipio',
  'borough',
  'parish',
  'county',
];
const COUNTY_WORD_RE = new RegExp(`\\b(${COUNTY_WORDS.join('|')})\\b`);
const STATE_PREFIX_RE =
  /^(?:free state|state|commonwealth|province|territory|prefecture|region|land|canton|department) of (.+)$/;
const STATE_SUFFIX_RE = /^(.+) (?:state|province|prefecture|territory)$/;

/**
 * Split an ask into what it names and how.
 * @param {string} text
 * @returns {{kind:'country'|'county'|'state'|'any', name:string, qualifiers:string[],
 *   postal:string|null, countyWord:string|null}|null}
 */
export function parseAdminQuery(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const segments = raw.split(',').map(normalizeAdminName).filter(Boolean);
  if (!segments.length) return null;
  const head = segments[0];
  const country =
    /^(?:country|nation) of (.+)$/.exec(head) ||
    /^(.+) (?:country|nation)$/.exec(head);
  if (country)
    return {
      kind: 'country',
      name: country[1],
      qualifiers: segments.slice(1),
      postal: null,
      countyWord: null,
      full: head,
    };
  const qualifiers = segments.slice(1);
  const postal = /^[A-Za-z]{2}$/.test(raw) ? raw.toLowerCase() : null;
  // "TX", "DC", "D.C.": written as an abbreviation, not a short word.
  const abbreviation = /^[A-Z]{2,3}$/.test(raw.replace(/[.\s]/g, ''));

  // "County Cork", "County of Los Angeles"
  const countyPrefix = /^county (?:of )?(.+)$/.exec(head);
  if (countyPrefix)
    return {
      kind: 'county',
      name: countyPrefix[1],
      qualifiers,
      postal: null,
      countyWord: 'county',
      full: head,
    };
  // "Travis County", "Travis County Texas", "Orleans Parish, LA"
  const county = COUNTY_WORD_RE.exec(head);
  if (county && county.index > 0) {
    const name = head.slice(0, county.index).trim();
    const rest = head.slice(county.index + county[1].length).trim();
    if (rest) qualifiers.unshift(rest);
    return {
      kind: 'county',
      name,
      qualifiers,
      postal: null,
      countyWord: county[1],
      full: head.slice(0, county.index + county[1].length),
    };
  }
  const prefix = STATE_PREFIX_RE.exec(head);
  if (prefix)
    return {
      kind: 'state',
      name: prefix[1],
      qualifiers,
      postal: null,
      countyWord: null,
      full: head,
      form: 'prefix',
    };
  const suffix = STATE_SUFFIX_RE.exec(head);
  if (suffix)
    return {
      kind: 'state',
      name: suffix[1],
      qualifiers,
      postal: null,
      countyWord: null,
      full: head,
      form: 'suffix',
    };
  return {
    kind: 'any',
    name: head,
    qualifiers,
    postal,
    abbreviation,
    countyWord: null,
  };
}

/** A qualifier names the unit's country ("Bavaria, Germany") or the unit
 * itself ("Washington, DC"). */
function qualifierMatches(entry, qualifier) {
  const q = COUNTRY_ALIASES.get(qualifier) || qualifier;
  return (
    entry.country === q ||
    entry.iso2 === q ||
    entry.keys.has(qualifier) ||
    entry.keys.has(`postal:${qualifier}`)
  );
}

/**
 * Rank candidates: a unit containing `near` first, then the match tier,
 * then distance from `near`, then larger area. Returns the ranked list.
 */
function rank(candidates, near) {
  const hasNear = Number.isFinite(near?.lat) && Number.isFinite(near?.lon);
  const scored = candidates.map(({ entry, tier }) => {
    const geometry = geometryOf(entry);
    const contains = hasNear
      ? polygonsContain(geometry.polygons, near.lat, near.lon)
      : false;
    const distanceKm = hasNear
      ? contains
        ? 0
        : boxDistanceKm(geometry.bbox, near.lat, near.lon)
      : 0;
    return { entry, tier, contains, distanceKm, areaKm2: geometry.areaKm2 };
  });
  scored.sort(
    (a, b) =>
      Number(b.contains) - Number(a.contains) ||
      a.tier - b.tier ||
      a.distanceKm - b.distanceKm ||
      b.areaKm2 - a.areaKm2,
  );
  return scored;
}

function toResult(scored, candidateCount) {
  const { entry } = scored;
  const { feature } = entry;
  const geometry = geometryOf(entry);
  // Parts are stored largest first, so polygons[0][0] is the main outline.
  const polygons = geometry.polygons;
  if (entry.kind === 'county') {
    return {
      kind: 'county',
      name: feature.full,
      region: feature.state,
      regionCode: feature.st,
      country: 'United States of America',
      id: feature.geoid,
      source: 'us-census',
      polygons,
      ring: polygons[0][0],
      bbox: geometry.bbox,
      areaKm2: geometry.areaKm2,
      label: geometry.label,
      candidates: candidateCount,
    };
  }
  return {
    kind: entry.kind,
    name: feature.nameEn || feature.name,
    localName: feature.name,
    type: feature.type,
    region: null,
    regionCode: feature.postal || null,
    country: feature.country,
    id: feature.iso || null,
    source: 'natural-earth',
    polygons,
    ring: polygons[0][0],
    bbox: geometry.bbox,
    areaKm2: geometry.areaKm2,
    label: geometry.label,
    candidates: candidateCount,
  };
}

async function countyCandidates(parsed) {
  const { byFull, byName, states } = await loadCounties();
  // An exact full name ("Orleans Parish") wins outright; without one, the
  // name with ANY county-equivalent word ("Anchorage Borough" finds
  // Anchorage Municipality). An independent city is only ever its full name
  // ("Fairfax city", "Carson City").
  let list = parsed.countyWord
    ? [
        ...(byFull.get(parsed.full || `${parsed.name} ${parsed.countyWord}`) ||
          byName.get(parsed.name) ||
          []),
      ]
    : [...(byFull.get(parsed.name) || [])];
  if (!list.length) return [];
  // Every qualifier must be a state or the US: "Travis County, TX, USA"
  // qualifies, "Travis County Courthouse, Texas" names something else.
  const stateByCode = new Map([...states].map(([name, st]) => [st, name]));
  const stateQualifiers = [];
  for (const q of parsed.qualifiers) {
    const state = states.has(q) ? q : stateByCode.get(q);
    if (state) stateQualifiers.push(state);
    else if (!isUnitedStates(q)) return [];
  }
  if (stateQualifiers.length)
    list = list.filter((i) => stateQualifiers.includes(i.entry.state));
  return list;
}

function isUnitedStates(qualifier) {
  return (
    (COUNTRY_ALIASES.get(qualifier) || qualifier) === 'united states of america'
  );
}

async function stateCandidates(parsed, { allowAmbiguous = false } = {}) {
  const { index } = await loadAdmin1();
  const keys = [];
  if (parsed.full) keys.push(parsed.full);
  keys.push(parsed.name);
  if (parsed.postal) keys.push(`postal:${parsed.postal}`);
  const seen = new Set();
  let list = [];
  for (const key of keys) {
    for (const item of index.get(key) || []) {
      if (seen.has(item.entry)) continue;
      seen.add(item.entry);
      list.push({ ...item, key, tier: key === parsed.full ? 0 : item.tier });
    }
  }
  // Every qualifier must place the unit: "Bavaria, Germany", "Washington,
  // DC" — not "Santa Barbara, California" (a city the pack does not hold).
  if (parsed.qualifiers.length)
    list = list.filter((i) =>
      parsed.qualifiers.every((q) => qualifierMatches(i.entry, q)),
    );
  if (allowAmbiguous) return list;
  // A bare name answers alone only for a prominent unit — a US state, a
  // Canadian province, Bavaria — never a French département, an English
  // county or a Bahamas district ("Long Island", "Santa Barbara", "Kent" are
  // likelier the places a geocoder knows). It must not also be a country or
  // a large city ("Georgia", "New York"), and a short code must be written
  // as one ("TX", not "tx"). Otherwise a qualifier, admin wording or the
  // geocoder decides.
  // A country qualifier places a name without making it a state: "New York,
  // USA" and "Madrid, Spain" stay the geocoder's; "Washington, DC" names the
  // unit itself.
  if (parsed.kind === 'any') {
    const short = parsed.name.replace(/ /g, '').length <= 3;
    if (short && (!parsed.abbreviation || CITY_ABBREVIATIONS.has(parsed.name)))
      return [];
    const namesUnit = (entry) =>
      parsed.qualifiers.some(
        (q) => entry.keys.has(q) || entry.keys.has(`postal:${q}`),
      );
    if (!parsed.qualifiers.length) {
      if (GENERIC_NAMES.has(parsed.name)) return [];
      return list.filter(
        (i) =>
          !i.entry.amb.has(i.key) &&
          !i.entry.ambAbroad.has(i.key) &&
          ((i.entry.feature.rank ?? Infinity) <= BARE_NAME_MAX_RANK ||
            i.entry.feature.cityState),
      );
    }
    // Qualified: a shared name abroad is settled by the country ("Victoria,
    // Australia"); one shared at home only by the unit's own name.
    return list.filter((i) => !i.entry.amb.has(i.key) || namesUnit(i.entry));
  }
  // "X State" only settles a name that is ambiguous on its own ("New York
  // State"); otherwise it is as likely a university ("Ohio State") and a
  // geocoder decides. A unit literally named so ("Free State") matches.
  if (parsed.form === 'suffix')
    return list.filter((i) => i.key === parsed.full || i.entry.amb.has(i.key));
  return list;
}

/**
 * Resolve an administrative unit from the ask's words alone.
 *
 * @param {string} query e.g. "Texas", "TX", "State of Texas", "Bavaria",
 *   "Bavaria, Germany", "Travis County", "Travis County, TX", "Orleans Parish"
 * @param {{near?: {lat:number, lon:number}|null}} [options] the camera's
 *   view centre — the tie-break between same-named units
 * @returns {Promise<AdminArea|null>}
 *
 * @typedef {{kind:'country'|'state'|'county', name:string, region:string|null,
 *   regionCode:string|null, country:string, id:string|null,
 *   source:'natural-earth'|'us-census',
 *   polygons:Array<Array<Array<[number,number]>>>, ring:Array<[number,number]>,
 *   bbox:number[], areaKm2:number, label:{lat:number, lon:number},
 *   candidates:number}} AdminArea
 */
export async function findAdminArea(query, { near = null } = {}) {
  const parsed = parseAdminQuery(query);
  if (!parsed || !parsed.name) return null;
  let candidates = [];
  if (parsed.kind === 'country') {
    candidates = await countryCandidates(parsed);
  } else if (parsed.kind === 'county') {
    // County wording also names admin-1 units abroad. Neither pack gets
    // first refusal: qualifiers exclude ineligible countries before ranking.
    const [counties, admin1] = await Promise.all([
      countyCandidates(parsed),
      stateCandidates({ ...parsed, kind: 'state' }),
    ]);
    candidates = [...counties, ...admin1];
  } else {
    candidates = await stateCandidates(parsed);
    if (!candidates.length || COUNTRY_TARGET_ALIASES.has(parsed.name)) {
      const countries = await countryCandidates(parsed);
      if (countries.length) {
        const states = await stateCandidates(parsed, { allowAmbiguous: true });
        if (
          states.length &&
          !Number.isFinite(near?.lat) &&
          !parsed.qualifiers.length
        )
          return null;
        candidates = [...countries, ...states];
      }
    }
    // A county-equivalent city: "Baltimore city", "Fairfax city, Virginia".
    if (!candidates.length && / city$/.test(parsed.name))
      candidates = await countyCandidates(parsed);
  }
  if (!candidates.length) return null;
  const ranked = rank(candidates, near);
  return toResult(ranked[0], candidates.length);
}

/**
 * Geocoder-confirmed lookup: the geocoder typed a country, state or
 * county, so the unit must carry one of `names` AND contain the geocoded
 * point. Ambiguity marks do not apply — the geocoder already chose.
 *
 * @param {string[]} names  the ask and the geocoder's own name for it
 * @param {number} lat
 * @param {number} lon
 * @param {'country'|'state'|'county'} scope
 * @returns {Promise<AdminArea|null>}
 */
export async function findAdminAreaAt(names, lat, lon, scope) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const parsedList = [...new Set((names || []).filter(Boolean))]
    .map(parseAdminQuery)
    .filter((p) => p?.name);
  if (!parsedList.length) return null;
  const containing = (items) => {
    const out = [];
    for (const item of items)
      if (
        !out.some((c) => c.entry === item.entry) &&
        polygonsContain(geometryOf(item.entry).polygons, lat, lon)
      )
        out.push(item);
    return out;
  };
  if (scope === 'country') {
    const countries = [];
    for (const parsed of parsedList)
      countries.push(
        ...(await countryCandidates({
          ...parsed,
          kind: 'country',
          qualifiers: [],
        })),
      );
    const found = containing(countries);
    return found.length
      ? toResult(rank(found, { lat, lon })[0], found.length)
      : null;
  }
  // The geocoder's scope says what kind of unit this is; the ask's wording
  // may omit it ("Travis" typed as a county). A US county that matches wins
  // outright — "New York County" is Manhattan, not the state.
  if (scope === 'county' && inUnitedStatesBox(lat, lon)) {
    const counties = [];
    for (const parsed of parsedList)
      counties.push(
        ...(await countyCandidates({
          ...parsed,
          kind: 'county',
          countyWord: parsed.countyWord || 'county',
          qualifiers: [],
        })),
      );
    const found = containing(counties);
    if (found.length)
      return toResult(rank(found, { lat, lon })[0], found.length);
  }
  const states = [];
  for (const parsed of parsedList)
    states.push(
      ...(await stateCandidates(
        { ...parsed, qualifiers: [] },
        { allowAmbiguous: true },
      )),
    );
  const found = containing(states);
  if (!found.length) return null;
  return toResult(rank(found, { lat, lon })[0], found.length);
}

/** Rough box around the US and its territories (skips the county pack elsewhere). */
function inUnitedStatesBox(lat, lon) {
  return (
    (lat >= 13 && lat <= 72 && (lon <= -64 || lon >= 144)) ||
    (lat >= -15 && lat <= -10 && lon <= -168)
  );
}
