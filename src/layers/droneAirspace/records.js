/**
 * Normalize an FAA Special Use Airspace feed, skipping individually invalid
 * features. Only a payload that is not a feature collection at all rejects
 * the whole snapshot: a single degenerate polygon must never blank the layer.
 */

const TYPE_LABELS = Object.freeze({
  P: 'Prohibited',
  R: 'Restricted',
});

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const textOrNull = (value) => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
};

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

/** Human label for a TYPE_CODE, or null when the code is not in the pack. */
export function droneAirspaceTypeLabel(typeCode) {
  return TYPE_LABELS[typeCode] || null;
}

export function normalizeDroneAirspaceSnapshot(geojson) {
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
    const typeCode = textOrNull(properties.TYPE_CODE);
    const type = droneAirspaceTypeLabel(typeCode);
    if (!type) continue;
    const polygons = normalizePolygons(feature.geometry);
    if (polygons === null || !polygons.length) continue;
    const objectId = finiteOrNull(Number(properties.OBJECTID));
    const featureId =
      feature.id == null || feature.id === '' ? null : String(feature.id);
    const stableId =
      objectId != null
        ? String(objectId)
        : featureId && !ids.has(featureId)
          ? featureId
          : null;
    if (stableId == null || ids.has(stableId)) continue;
    ids.add(stableId);
    rows.push({
      stableId,
      name: textOrNull(properties.NAME),
      typeCode,
      type,
      lowerDesc: textOrNull(properties.LOWER_DESC),
      upperDesc: textOrNull(properties.UPPER_DESC),
      timesOfUse: textOrNull(properties.TIMESOFUSE),
      agency: textOrNull(properties.CONT_AGENT),
      city: textOrNull(properties.CITY),
      state: textOrNull(properties.STATE),
      polygons,
    });
  }
  return rows;
}
