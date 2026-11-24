/**
 * WFIGS perimeters: the proxy's rows (normalizeFirePerimeterSnapshot) and
 * the snapshot the layer draws (firePerimeterSnapshot).
 *
 * The server and the package's `./layers/perimeters/source` and
 * `./layers/perimeters/records` exports import this module, so it marks text
 * with msg() only and imports no rendering code. The layer translates `note`
 * when it shows it. A host that places incident cards itself (a server, a
 * worker) takes `perimeterAnchorDegrees` from `./layers/perimeters/records`
 * and stands them where the map does.
 */

import { msg } from '../../i18n/marker.js';

/**
 * Normalize a WFIGS feed, skipping individually invalid features.
 * Only a payload that is not a feature collection at all rejects the whole
 * snapshot: a single degenerate incident (ArcGIS emits geometry:null when
 * maxAllowableOffset generalizes a tiny polygon away) must never blank the
 * layer — a failed first update makes the lifecycle disable it entirely.
 */

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const textOrNull = (value) => (typeof value === 'string' ? value : null);

function validRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  for (const position of ring) {
    if (!Array.isArray(position) || position.length < 2) return false;
    const [lon, lat] = position;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) return false;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return false;
  }
  return true;
}

/** Normalize Polygon/MultiPolygon geometry to an array of polygons (each an
 * array of rings). Returns null on malformed geometry, [] when empty. */
function normalizePolygons(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  let polygons;
  if (geometry.type === 'Polygon') polygons = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates;
  else return null;
  if (!Array.isArray(polygons)) return null;
  const result = [];
  for (const rings of polygons) {
    if (!Array.isArray(rings)) return null;
    if (!rings.length) continue;
    if (!rings.every(validRing)) return null;
    result.push(rings);
  }
  return result;
}

export function normalizeFirePerimeterSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      continue;
    const polygons = normalizePolygons(feature.geometry);
    if (polygons === null || !polygons.length) continue;
    const uniqueId = properties.attr_UniqueFireIdentifier;
    const stableId =
      typeof uniqueId === 'string' && uniqueId !== ''
        ? uniqueId
        : feature.id == null || feature.id === ''
          ? null
          : String(feature.id);
    if (stableId == null || ids.has(stableId)) continue;
    ids.add(stableId);
    rows.push({
      stableId,
      name:
        typeof properties.poly_IncidentName === 'string'
          ? properties.poly_IncidentName
          : null,
      acres: finiteOrNull(properties.attr_IncidentSize),
      containedPct: finiteOrNull(properties.attr_PercentContained),
      state:
        typeof properties.attr_POOState === 'string'
          ? properties.attr_POOState
          : null,
      category:
        typeof properties.attr_IncidentTypeCategory === 'string'
          ? properties.attr_IncidentTypeCategory
          : null,
      discoveredTime: finiteOrNull(properties.attr_FireDiscoveryDateTime),
      updatedTime: finiteOrNull(properties.poly_DateCurrent),
      polygonTime: finiteOrNull(properties.poly_PolygonDateTime),
      cause: textOrNull(properties.attr_FireCause),
      behavior: textOrNull(properties.attr_FireBehaviorGeneral),
      personnel: finiteOrNull(properties.attr_TotalIncidentPersonnel),
      county: textOrNull(properties.attr_POOCounty),
      costToDate: finiteOrNull(properties.attr_EstimatedCostToDate),
      complexity: textOrNull(properties.attr_IncidentComplexityLevel),
      complexName: textOrNull(properties.attr_CpxName),
      polygons,
    });
  }
  return rows;
}

/** Shoelace area along short longitude edges (degree², relative sizes only). */
function ringArea(ring) {
  let sum = 0;
  let [x1, y1] = ring[0];
  for (let i = 1; i < ring.length; i++) {
    let delta = ring[i][0] - ring[i - 1][0];
    if (delta > 180) delta -= 360;
    else if (delta < -180) delta += 360;
    const x2 = x1 + delta;
    const y2 = ring[i][1];
    sum += x1 * y2 - x2 * y1;
    x1 = x2;
    y1 = y2;
  }
  return Math.abs(sum / 2);
}

/**
 * Anchor point for the incident card: the vertex mean of the largest polygon's
 * outer ring, with circular longitude. Callers own the Cartesian conversion.
 * @param {Array<Array<Array<[number, number]>>>} polygons - Normalized rows' polygons.
 * @returns {{lon: number, lat: number}}
 */
export function perimeterAnchorDegrees(polygons) {
  let best = null;
  let bestArea = -1;
  for (const rings of polygons) {
    const outer = rings[0];
    const area = ringArea(outer);
    if (area > bestArea) {
      bestArea = area;
      best = outer;
    }
  }
  // Vertex mean over the closed ring (first == last point dropped): perimeters
  // are compact enough that this stays inside or near the polygon.
  let sinLon = 0;
  let cosLon = 0;
  let lat = 0;
  const count = best.length - 1;
  const toRad = Math.PI / 180;
  for (let i = 0; i < count; i++) {
    sinLon += Math.sin(best[i][0] * toRad);
    cosLon += Math.cos(best[i][0] * toRad);
    lat += best[i][1];
  }
  return { lon: Math.atan2(sinLon, cosLon) / toRad, lat: lat / count };
}

/** A short hash of a string (cyrb53), base 36. */
function hashText(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** WFIGS times up to this far ahead of our clock (clock skew) are taken as now; later ones are unknown. */
const CLOCK_SKEW_MS = 10 * 60 * 1000;

/**
 * The WFIGS snapshot for the Fire Perimeters layer (contract:
 * `createFirePerimetersLayer`), from the proxy's rows.
 *
 * WFIGS keeps one perimeter per fire, so each of its polygons is one piece,
 * born when the perimeter was mapped (`poly_PolygonDateTime`, else the
 * record's last edit `poly_DateCurrent`). A piece's id is the record's
 * version (its last edit, else a hash of its mapping time and outline) and
 * its place in the perimeter, so an edit draws the fire's pieces anew.
 * @param {object[]} rows - normalizeFirePerimeterSnapshot rows.
 * @param {{fetchedAt?: number|null, stale?: boolean, now?: number}} [options]
 * @returns {{at: null, fetchedAt: number|null, stale: boolean,
 *   revision: string, note: string, fires: object[], pieces: object[]}}
 */
export function firePerimeterSnapshot(
  rows,
  { fetchedAt = null, stale = false, now = Date.now() } = {},
) {
  const fires = [];
  const pieces = [];
  const versions = [];
  for (const row of rows) {
    const { stableId, polygons, polygonTime, ...facts } = row;
    const mapped = polygonTime ?? facts.updatedTime;
    const grown =
      Number.isFinite(mapped) && mapped <= now + CLOCK_SKEW_MS
        ? Math.min(mapped, now)
        : null;
    fires.push({
      ...facts,
      id: stableId,
      lastGrowthTime: grown,
      anchor: perimeterAnchorDegrees(polygons),
    });
    // Without poly_DateCurrent, a hash of the mapping time and outline
    // stands in for it. Both the revision and piece ids assume WFIGS changes
    // poly_DateCurrent with every polygon edit. An edit that leaves this
    // date unchanged keeps the old outline drawn.
    const version = Number.isFinite(facts.updatedTime)
      ? String(facts.updatedTime)
      : `h${hashText(`${polygonTime ?? ''}:${JSON.stringify(polygons)}`)}`;
    polygons.forEach((rings, index) =>
      pieces.push({
        id: `${version}/${index}`,
        fireId: stableId,
        born: grown,
        polygons: [rings],
        outline: rings,
      }),
    );
    versions.push(`${stableId}@${version}`);
  }
  return {
    at: null,
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
    stale: stale === true,
    revision: versions.sort().join('|'),
    note: msg(
      "Age counts from WFIGS mapping time, else the record's last edit. Perimeters simplified to ~100 m.",
    ),
    fires,
    pieces,
  };
}
