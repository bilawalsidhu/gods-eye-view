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
