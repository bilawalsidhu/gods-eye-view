/**
 * Normalize an FAA Special Use Airspace feed, skipping individually invalid
 * features. Only a payload that is not a feature collection at all rejects
 * the whole snapshot: a single degenerate polygon must never blank the layer.
 */

import { msg } from '../../i18n/marker.js';

const TYPE_LABELS = Object.freeze({
  P: msg('Prohibited'),
  R: msg('Restricted'),
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

/**
 * One SUA altitude limit from its VAL/UOM/CODE triple, in aviation notation:
 * `SFC`, `500 ft AGL`, `5,000 ft MSL`, `FL180` or `Unlimited`. The *_DESC
 * fields are inclusion qualifiers (TI/TNI/ANI), not altitudes. Returns null
 * when the triple does not describe a limit.
 */
export function droneAirspaceAltitude(value, uom, code) {
  const unit = textOrNull(uom)?.toUpperCase() ?? null;
  const reference = textOrNull(code)?.toUpperCase() ?? null;
  if (reference === 'UNLTD') return 'Unlimited';
  const number = Number(value);
  if (value == null || value === '' || !Number.isFinite(number) || number < 0)
    return null;
  if (unit === 'FL' || reference === 'STD') return `FL${Math.round(number)}`;
  const feet = `${Math.round(number).toLocaleString('en-US')} ft`;
  if (reference === 'SFC') return number === 0 ? 'SFC' : `${feet} AGL`;
  if (reference === 'MSL') return `${feet} MSL`;
  return unit === 'FT' || unit == null ? feet : null;
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
      lowerAltitude: droneAirspaceAltitude(
        properties.LOWER_VAL,
        properties.LOWER_UOM,
        properties.LOWER_CODE,
      ),
      upperAltitude: droneAirspaceAltitude(
        properties.UPPER_VAL,
        properties.UPPER_UOM,
        properties.UPPER_CODE,
      ),
      timesOfUse: textOrNull(properties.TIMESOFUSE),
      agency: textOrNull(properties.CONT_AGENT),
      city: textOrNull(properties.CITY),
      state: textOrNull(properties.STATE),
      polygons,
    });
  }
  return rows;
}
