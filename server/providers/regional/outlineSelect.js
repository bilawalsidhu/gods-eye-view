import { normalizePlaceName } from './nominatimCache.js';

/**
 * Which Nominatim results may answer which voice ask, and how their polygons
 * are bounded. Pure: no I/O.
 *
 * A search returns whatever matches the words best. "Mission District" can
 * come back as a car-charging station and "Bandra" as a railway station, so a
 * result is accepted only when its OSM class (and, for broad classes, its
 * type) suits the kind of thing that was asked for, it carries a polygon, and
 * its name actually answers the words.
 */

/** Ask kinds the outline route answers. */
export const OUTLINE_KINDS = Object.freeze([
  'city',
  'admin',
  'neighborhood',
  'landmark',
  'building',
]);

/** Simplification tolerance (degrees) sent upstream, per ask kind. */
export const OUTLINE_POLYGON_THRESHOLD = Object.freeze({
  city: 0.0005,
  admin: 0.0005,
  neighborhood: 0.0005,
  landmark: 0.00005,
  building: 0.00005,
});

/** Total vertices returned for one outline, and parts/holes kept. */
export const OUTLINE_MAX_VERTICES = 6000;
const OUTLINE_MAX_PARTS = 24;
const OUTLINE_MAX_HOLES = 16;

const ANY = '*';

const SETTLEMENT_PLACES = [
  'city',
  'town',
  'village',
  'municipality',
  'borough',
  'hamlet',
];

const CIVIC_AMENITIES = [
  'university',
  'college',
  'school',
  'kindergarten',
  'hospital',
  'clinic',
  'place_of_worship',
  'monastery',
  'townhall',
  'courthouse',
  'library',
  'theatre',
  'cinema',
  'arts_centre',
  'community_centre',
  'conference_centre',
  'events_venue',
  'exhibition_centre',
  'music_venue',
  'planetarium',
  'marketplace',
  'prison',
  'grave_yard',
  'fire_station',
  'police',
  'embassy',
  'public_building',
];

const LANDMARK_TOURISM = [
  'attraction',
  'theme_park',
  'zoo',
  'aquarium',
  'museum',
  'gallery',
  'viewpoint',
  'camp_site',
  'hotel',
  'resort',
];

const MAN_MADE_STRUCTURES = [
  'tower',
  'lighthouse',
  'pier',
  'bridge',
  'works',
  'dam',
  'observatory',
  'wastewater_plant',
  'water_works',
  'breakwater',
];

/**
 * Accepted `class → types` per ask kind. `*` accepts every type of that
 * class. Anything absent is rejected: roads, railways, stations, shops,
 * guideposts and single facilities never answer an area ask.
 */
export const OUTLINE_ACCEPT = Object.freeze({
  city: {
    boundary: ['administrative'],
    place: SETTLEMENT_PLACES,
  },
  admin: {
    boundary: ['administrative'],
    place: ['country', 'state', 'province', 'region', 'county', 'district'],
  },
  neighborhood: {
    boundary: ['administrative'],
    place: ['suburb', 'quarter', 'neighbourhood', 'borough', 'city_block'],
  },
  landmark: {
    leisure: ANY,
    landuse: ANY,
    amenity: CIVIC_AMENITIES,
    tourism: LANDMARK_TOURISM,
    building: ANY,
    natural: ANY,
    water: ANY,
    waterway: ['riverbank', 'dock'],
    historic: ANY,
    man_made: MAN_MADE_STRUCTURES,
    office: ['government', 'diplomatic'],
    aeroway: ['aerodrome', 'heliport', 'terminal'],
    military: ANY,
    boundary: ['national_park', 'protected_area'],
    place: ['island', 'islet', 'square'],
  },
  // Single structures only: no campuses, grounds, parks or camp sites.
  building: {
    building: ANY,
    amenity: [
      'place_of_worship',
      'townhall',
      'courthouse',
      'library',
      'theatre',
      'cinema',
      'arts_centre',
      'community_centre',
      'conference_centre',
      'exhibition_centre',
      'music_venue',
      'planetarium',
      'fire_station',
      'police',
      'embassy',
      'public_building',
    ],
    tourism: ['museum', 'gallery', 'hotel', 'attraction'],
    historic: ['building', 'castle', 'church', 'fort', 'palace', 'monastery'],
    man_made: ['tower', 'lighthouse', 'observatory'],
    office: ANY,
  },
});

/**
 * Administrative evidence per ask kind: an address type, or a Nominatim
 * place_rank band (country 4, state 8, county 10-12, city 12-16, suburb 18-20,
 * neighbourhood 20-22). An administrative boundary with neither is refused.
 */
const ADMIN_EVIDENCE = Object.freeze({
  city: {
    types: ['city', 'town', 'village', 'municipality', 'borough', 'hamlet'],
    ranks: [12, 18],
  },
  admin: {
    types: [
      'country',
      'state',
      'province',
      'region',
      'county',
      'district',
      'state_district',
    ],
    ranks: [2, 14],
  },
  neighborhood: {
    types: ['suburb', 'quarter', 'neighbourhood', 'city_district', 'borough'],
    ranks: [17, 24],
  },
});

const KNOWN_ADMIN_TYPES = new Set(
  Object.values(ADMIN_EVIDENCE).flatMap((evidence) => evidence.types),
);

/**
 * Nominatim address types whose meaning is stable enough for the area consumer's
 * country/admin1/admin2 contract. `region`, `district` and numeric admin levels
 * vary by country, so they remain unverified instead of being guessed.
 */
const VERIFIED_ADMIN_LEVEL = Object.freeze({
  country: 'country',
  state: 'admin1',
  province: 'admin1',
  county: 'admin2',
  state_district: 'admin2',
});

const EXPLICIT_NAME_LEVEL = Object.freeze({
  country: 'country',
  nation: 'country',
  province: 'admin1',
  state: 'admin1',
  region: 'admin1',
  oblast: 'admin1',
  prefecture: 'admin1',
  canton: 'admin1',
  governorate: 'admin1',
  county: 'admin2',
  district: 'admin2',
  department: 'admin2',
  zone: 'retired',
});

function explicitNameEvidence(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
  const prefix = normalized.match(
    /^(country|nation|province|state|region|zone|oblast|prefecture|canton|governorate|county|district|department)\s+of\b/,
  )?.[1];
  const suffix = normalized.match(
    /\b(country|nation|province|state|region|zone|oblast|prefecture|canton|governorate|county|district|department)$/,
  )?.[1];
  const levels = new Set(
    [prefix, suffix]
      .filter(Boolean)
      .map((type) => EXPLICIT_NAME_LEVEL[type])
      .filter(Boolean),
  );
  if (levels.size > 1) return { contradictory: true, level: null };
  return { contradictory: false, level: levels.values().next().value || null };
}

/**
 * Verified administrative identity carried by the selected result itself.
 * Never infer it from the request, desired kind, rank, or a separate geocoder
 * anchor. A retired name is preserved without a level so downstream policy can
 * reject it explicitly; every other contradiction stays wholly unverified.
 */
function selectedAdminIdentity(kind, row) {
  if (kind !== 'admin') return null;
  const adminLevel =
    VERIFIED_ADMIN_LEVEL[String(row?.addresstype || '').toLowerCase()];
  const authoritativeAdminArea = String(row?.name || '').trim();
  if (!adminLevel || !authoritativeAdminArea) return null;
  // Validate the complete authoritative name. `adminArea` is truncated only
  // for display after every prefix/suffix signal has been considered.
  const { contradictory, level: nameLevel } = explicitNameEvidence(
    authoritativeAdminArea,
  );
  if (contradictory) return null;
  const adminArea = authoritativeAdminArea.slice(0, 160);
  if (nameLevel === 'retired') return { adminArea };
  if (nameLevel && nameLevel !== adminLevel) return null;
  return { adminArea, adminLevel };
}

/** Whether an administrative boundary is at the level the ask names. */
export function adminLevelFits(kind, row) {
  const evidence = ADMIN_EVIDENCE[kind];
  if (!evidence) return true;
  const type = String(row?.addresstype || '').toLowerCase();
  if (type && evidence.types.includes(type)) return true;
  // A recognized type is direct evidence. Rank is only a fallback when the
  // upstream answer omits the type or supplies a value we do not understand;
  // the overlapping county/city rank bands must not override `county`.
  if (KNOWN_ADMIN_TYPES.has(type)) return false;
  const rank = Number(row?.place_rank);
  if (Number.isFinite(rank))
    return rank >= evidence.ranks[0] && rank <= evidence.ranks[1];
  return false;
}

/** Largest footprint (m²) a non-`building` result may have for a building ask. */
const BUILDING_MAX_AREA_M2 = 150_000;

/** Approximate area (m²) of a [lon, lat] ring. */
function ringAreaM2(ring) {
  const lat0 = ring[0][1];
  const k = 111_320 * 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return ringArea(ring) * k;
}

/** Whether a result's class/type suits the ask kind. */
export function acceptsOutlineClass(kind, osmClass, osmType) {
  const rules = OUTLINE_ACCEPT[kind];
  if (!rules) return false;
  const types = rules[String(osmClass || '').toLowerCase()];
  if (!types) return false;
  return types === ANY || types.includes(String(osmType || '').toLowerCase());
}

const STOP_WORDS = new Set(['the', 'of', 'de', 'la', 'le', 'el', 'and']);

/** Scripts written without spaces between words. */
const UNSPACED_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** Whether `needle` occurs in `hay` as whole consecutive words. */
function containsWords(hay, needle) {
  for (let i = 0; i + needle.length <= hay.length; i++)
    if (needle.every((word, j) => hay[i + j] === word)) return true;
  return false;
}

/** Significant words of the part of a query before the first comma. */
function queryWords(query) {
  const head = String(query ?? '').split(',')[0];
  return normalizePlaceName(head)
    .split(' ')
    .filter((word) => word && !STOP_WORDS.has(word));
}

/**
 * Whether a result's names answer the query. Most of the query's words must
 * appear among one name's words, or one name must contain the whole query
 * (for scripts written without spaces).
 */
export function outlineNameMatches(row, query) {
  const words = queryWords(query);
  if (!words.length) return false;
  const whole = words.join(' ');
  const names = new Set();
  const add = (value) => {
    const name = normalizePlaceName(value);
    if (name) names.add(name);
  };
  add(row?.name);
  add(String(row?.display_name || '').split(',')[0]);
  if (row?.namedetails && typeof row.namedetails === 'object')
    for (const value of Object.values(row.namedetails)) add(value);
  const unspaced = UNSPACED_SCRIPT_RE.test(whole);
  for (const name of names) {
    const nameWords = name.split(' ');
    // Whole words only: "York" never matches "Yorkshire Park".
    if (containsWords(nameWords, words)) return true;
    // Scripts without spaces compare by characters instead.
    if (unspaced && name.replace(/ /g, '').includes(whole.replace(/ /g, '')))
      return true;
    const nameSet = new Set(nameWords);
    const hits = words.filter((word) => nameSet.has(word)).length;
    if (words.length > 1 && hits >= Math.ceil(words.length * 0.6)) return true;
  }
  return false;
}

const finiteLon = (value) =>
  Number.isFinite(value) && value >= -180 && value <= 180;
const finiteLat = (value) =>
  Number.isFinite(value) && value >= -90 && value <= 90;

/** A valid closed ring of [lon, lat] numbers, or null. */
function cleanRing(ring) {
  if (!Array.isArray(ring)) return null;
  const out = [];
  for (const point of ring) {
    if (!Array.isArray(point)) return null;
    const lon = Number(point[0]);
    const lat = Number(point[1]);
    if (!finiteLon(lon) || !finiteLat(lat)) return null;
    out.push([lon, lat]);
  }
  if (out.length < 4) return null;
  const [first, last] = [out[0], out.at(-1)];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([...first]);
  return out;
}

/** Planar ring area in squared degrees (only used to rank parts). */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return Math.abs(sum / 2);
}

/** Polygon/MultiPolygon GeoJSON → `[[outer, ...holes], …]`, largest first. */
export function polygonsFromGeoJson(geometry) {
  const raw =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : null;
  if (!Array.isArray(raw)) return null;
  const polygons = [];
  for (const polygon of raw) {
    if (!Array.isArray(polygon)) continue;
    const outer = cleanRing(polygon[0]);
    if (!outer) continue;
    const holes = polygon
      .slice(1)
      .map(cleanRing)
      .filter(Boolean)
      .sort((a, b) => ringArea(b) - ringArea(a))
      .slice(0, OUTLINE_MAX_HOLES);
    polygons.push({ rings: [outer, ...holes], area: ringArea(outer) });
  }
  if (!polygons.length) return null;
  polygons.sort((a, b) => b.area - a.area);
  return polygons.slice(0, OUTLINE_MAX_PARTS).map((entry) => entry.rings);
}

/** Iterative Douglas–Peucker on a closed ring (keeps it closed, ≥ 4 points). */
function simplifyClosedRing(ring, tolerance) {
  if (ring.length <= 8 || tolerance <= 0) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const [start, end] = stack.pop();
    const [ax, ay] = ring[start];
    const [bx, by] = ring[end];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let bestD = tol2;
    for (let i = start + 1; i < end; i++) {
      const [px, py] = ring[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px;
      const ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([start, best], [best, end]);
    }
  }
  const out = ring.filter((_point, index) => keep[index]);
  return out.length >= 4 ? out : ring;
}

const countVertices = (polygons) =>
  polygons.reduce(
    (sum, rings) => sum + rings.reduce((n, ring) => n + ring.length, 0),
    0,
  );

/** Simplify until the whole outline fits the vertex cap. */
export function capOutlineVertices(
  polygons,
  maxVertices = OUTLINE_MAX_VERTICES,
) {
  let current = polygons;
  let tolerance = 0.00002;
  for (let round = 0; round < 12; round++) {
    if (countVertices(current) <= maxVertices) return current;
    current = polygons.map((rings) =>
      rings.map((ring) => simplifyClosedRing(ring, tolerance)),
    );
    tolerance *= 2;
  }
  // Still over: keep the largest parts that fit, outer rings only.
  const kept = [];
  let total = 0;
  for (const rings of current) {
    const outer = rings[0];
    if (total + outer.length > maxVertices) break;
    kept.push([outer]);
    total += outer.length;
  }
  return kept.length ? kept : null;
}

/**
 * The first result within the limit that suits the ask, names the place and
 * carries a polygon — or null with the reason each result was passed over.
 *
 * @param {object[]} rows  Nominatim jsonv2 results, in upstream order.
 * @param {{kind: string, query: string}} ask
 */
export function selectOutlineResult(rows, { kind, query }) {
  const skipped = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const osmClass = row?.category || row?.class;
    const osmType = row?.type;
    const label = `${osmClass}=${osmType}`;
    if (!acceptsOutlineClass(kind, osmClass, osmType)) {
      skipped.push(`${label}: wrong type`);
      continue;
    }
    if (
      String(osmClass).toLowerCase() === 'boundary' &&
      String(osmType).toLowerCase() === 'administrative' &&
      !adminLevelFits(kind, row)
    ) {
      skipped.push(`${label}: level`);
      continue;
    }
    if (!outlineNameMatches(row, query)) {
      skipped.push(`${label}: name`);
      continue;
    }
    const parsed = polygonsFromGeoJson(row?.geojson);
    if (!parsed) {
      skipped.push(`${label}: no polygon`);
      continue;
    }
    // A building ask needs building evidence: the building class, or a
    // footprint no larger than a large building.
    if (
      kind === 'building' &&
      String(osmClass).toLowerCase() !== 'building' &&
      ringAreaM2(parsed[0][0]) > BUILDING_MAX_AREA_M2
    ) {
      skipped.push(`${label}: not a building`);
      continue;
    }
    const polygons = capOutlineVertices(parsed);
    if (!polygons) {
      skipped.push(`${label}: too large`);
      continue;
    }
    const adminIdentity = selectedAdminIdentity(kind, row);
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    return {
      outline: {
        name: String(row.name || '').slice(0, 160) || null,
        displayName: String(row.display_name || '').slice(0, 300) || null,
        class: String(osmClass),
        type: String(osmType),
        osm:
          row.osm_type && row.osm_id != null
            ? `${row.osm_type}/${row.osm_id}`
            : null,
        ...(adminIdentity || {}),
        center: finiteLat(lat) && finiteLon(lon) ? { lat, lon } : null,
        polygons,
      },
      skipped,
    };
  }
  return { outline: null, skipped };
}

/**
 * Coarse view bias: the centre is snapped to a grid (1° for places, 0.05°
 * for small grounds) so small camera moves reuse the same cache entry, and
 * the viewbox sent upstream is built from the snapped centre.
 */
export function outlineBias(kind, lat, lon) {
  // Missing is missing: Number(null) and Number('') would read as (0, 0).
  const given = (value) =>
    value !== null &&
    value !== undefined &&
    (typeof value === 'number' || String(value).trim() !== '');
  if (!given(lat) || !given(lon)) return null;
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!finiteLat(latitude) || !finiteLon(longitude)) return null;
  const small = kind === 'landmark' || kind === 'building';
  const step = small ? 0.05 : 1;
  const half = small ? 0.25 : 2;
  const snap = (value) => Math.round(value / step) * step;
  const cLat = Number(snap(latitude).toFixed(2));
  const cLon = Number(snap(longitude).toFixed(2));
  const clampLat = (value) => Math.max(-90, Math.min(90, value));
  const clampLon = (value) => Math.max(-180, Math.min(180, value));
  return {
    key: `${cLat},${cLon}`,
    viewbox: [
      clampLon(cLon - half),
      clampLat(cLat + half),
      clampLon(cLon + half),
      clampLat(cLat - half),
    ]
      .map((value) => Number(value.toFixed(4)))
      .join(','),
  };
}
