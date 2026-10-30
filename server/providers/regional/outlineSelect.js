import { normalizePlaceName } from './nominatimCache.js';
import { pointInRing } from '../../../src/data/adminBoundaries.js';

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
const OUTLINE_MAX_VERTICES = 6000;
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
const OUTLINE_ACCEPT = Object.freeze({
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
 * Administrative evidence per ask kind: a recognized address type is required.
 * A supplied numeric place_rank must also fit the ask's broad band (country 4,
 * state 8, county 10-12, city 12-16, suburb 18-20, neighbourhood 20-22).
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

/** Whether supplied administrative evidence contradicts the accepted identity. */
function adminLevelFits(kind, row) {
  const evidence = ADMIN_EVIDENCE[kind];
  if (!evidence) return true;
  const place = String(row?.category || row?.class).toLowerCase() === 'place';
  // A place row already has an accepted type. Missing address evidence must
  // not erase it, but explicit contradictory evidence must not bypass checks.
  if (!place || Object.hasOwn(row, 'addresstype')) {
    if (typeof row?.addresstype !== 'string') return false;
    const type = row.addresstype.toLowerCase();
    if (
      !evidence.types.includes(type) &&
      !(place && type === String(row.type).toLowerCase())
    )
      return false;
  }
  // Rank can corroborate or contradict an explicit identity, never invent it.
  // JSONv2 supplies a number; coercing arrays or strings hides malformed data.
  if (!Object.hasOwn(row, 'place_rank')) return true;
  const rank = row.place_rank;
  return (
    Number.isInteger(rank) &&
    // Boundary rank bands do not describe every accepted place type.
    (place || (rank >= evidence.ranks[0] && rank <= evidence.ranks[1]))
  );
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
 * Settlements require one complete normalized name or explicit returned alias.
 * Landmark/building asks retain their word-overlap and unspaced-script shorthand.
 */
function outlineNameMatches(row, query, kind) {
  const names = new Set();
  const add = (value) => {
    const name = normalizePlaceName(value);
    if (name) names.add(name);
  };
  add(row?.name);
  add(String(row?.display_name || '').split(',')[0]);
  if (row?.namedetails && typeof row.namedetails === 'object')
    for (const value of Object.values(row.namedetails)) add(value);
  if (kind === 'city' || kind === 'admin' || kind === 'neighborhood') {
    const head = normalizePlaceName(String(query ?? '').split(',')[0]);
    return Boolean(head) && names.has(head);
  }
  const words = queryWords(query);
  if (!words.length) return false;
  const whole = words.join(' ');
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
    const [lon, lat] = point;
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
function polygonsFromGeoJson(geometry) {
  const raw =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : null;
  if (!Array.isArray(raw) || !raw.length || raw.length > OUTLINE_MAX_PARTS)
    return null;
  const polygons = [];
  for (const polygon of raw) {
    if (
      !Array.isArray(polygon) ||
      !polygon.length ||
      polygon.length - 1 > OUTLINE_MAX_HOLES
    )
      return null;
    const outer = cleanRing(polygon[0]);
    if (!outer) return null;
    const holes = polygon.slice(1).map(cleanRing);
    if (holes.some((hole) => !hole)) return null;
    polygons.push({ rings: [outer, ...holes], area: ringArea(outer) });
  }
  polygons.sort((a, b) => b.area - a.area);
  return polygons.map((entry) => entry.rings);
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

const edgeSide = (p, q, r) =>
  (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
const onEdge = (p, q, r) =>
  r[0] >= Math.min(p[0], q[0]) &&
  r[0] <= Math.max(p[0], q[0]) &&
  r[1] >= Math.min(p[1], q[1]) &&
  r[1] <= Math.max(p[1], q[1]);

/** Intersection, including touching, of two planar closed-ring edges. */
function edgesIntersect(a, b, c, d) {
  if (
    Math.max(a[0], b[0]) < Math.min(c[0], d[0]) ||
    Math.max(c[0], d[0]) < Math.min(a[0], b[0]) ||
    Math.max(a[1], b[1]) < Math.min(c[1], d[1]) ||
    Math.max(c[1], d[1]) < Math.min(a[1], b[1])
  )
    return false;
  const ac = edgeSide(a, b, c);
  const ad = edgeSide(a, b, d);
  const ca = edgeSide(c, d, a);
  const cb = edgeSide(c, d, b);
  return (
    (ac === 0 && onEdge(a, b, c)) ||
    (ad === 0 && onEdge(a, b, d)) ||
    (ca === 0 && onEdge(c, d, a)) ||
    (cb === 0 && onEdge(c, d, b)) ||
    (ac > 0 !== ad > 0 && ca > 0 !== cb > 0)
  );
}

function ringsIntersect(a, b) {
  for (let i = 1; i < a.length; i++)
    for (let j = 1; j < b.length; j++)
      if (edgesIntersect(a[i - 1], a[i], b[j - 1], b[j])) return true;
  return false;
}

/**
 * Check only generated bounded output, not a new input-geometry policy.
 * Touching generated boundaries are conservatively unsupported here.
 */
function simplifiedTopologyFits(polygons) {
  for (const [outer, ...holes] of polygons) {
    for (const ring of [outer, ...holes]) {
      if (ringArea(ring) === 0) return false;
      for (let i = 1; i < ring.length; i++)
        for (let j = i + 2; j < ring.length; j++) {
          if (i === 1 && j === ring.length - 1) continue;
          if (edgesIntersect(ring[i - 1], ring[i], ring[j - 1], ring[j]))
            return false;
        }
    }
    for (let i = 0; i < holes.length; i++) {
      const hole = holes[i];
      if (
        !hole.every(([lon, lat]) => pointInRing(outer, lat, lon)) ||
        ringsIntersect(outer, hole)
      )
        return false;
      for (let j = 0; j < i; j++) {
        const other = holes[j];
        if (
          ringsIntersect(hole, other) ||
          pointInRing(other, hole[0][1], hole[0][0]) ||
          pointInRing(hole, other[0][1], other[0][0])
        )
          return false;
      }
    }
  }
  return true;
}

/** Simplify until the whole outline fits the vertex cap. */
export function capOutlineVertices(
  polygons,
  maxVertices = OUTLINE_MAX_VERTICES,
) {
  let current = polygons;
  let tolerance = 0.00002;
  for (let round = 0; round < 12; round++) {
    if (countVertices(current) <= maxVertices)
      return current === polygons || simplifiedTopologyFits(current)
        ? current
        : null;
    current = polygons.map((rings) =>
      rings.map((ring) => simplifyClosedRing(ring, tolerance)),
    );
    tolerance *= 2;
  }
  // Never turn a resource refusal into an apparently complete partial outline.
  return countVertices(current) <= maxVertices &&
    simplifiedTopologyFits(current)
    ? current
    : null;
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
      (String(osmClass).toLowerCase() === 'place' ||
        (String(osmClass).toLowerCase() === 'boundary' &&
          String(osmType).toLowerCase() === 'administrative')) &&
      !adminLevelFits(kind, row)
    ) {
      skipped.push(`${label}: level`);
      continue;
    }
    if (!outlineNameMatches(row, query, kind)) {
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
