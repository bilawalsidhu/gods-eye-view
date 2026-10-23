/**
 * Normalize a MET Norway MetAlerts 2.0 GeoJSON feed, skipping individually
 * invalid features. Only a payload that is not a feature collection at all
 * rejects the snapshot: one malformed warning must never blank the layer.
 */

/** MET awareness levels, least to most severe. */
export const WARNING_LEVELS = Object.freeze(['yellow', 'orange', 'red']);

const text = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

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
 * The awareness colour of one warning: `awareness_level` reads
 * "2; yellow; Moderate"; `riskMatrixColor` is the fallback.
 * @param {object} properties MetAlerts feature properties.
 * @returns {'yellow' | 'orange' | 'red' | null}
 */
export function warningLevel(properties) {
  const fromAwareness = String(properties?.awareness_level ?? '')
    .split(';')[1]
    ?.trim()
    .toLowerCase();
  if (WARNING_LEVELS.includes(fromAwareness)) return fromAwareness;
  const fromMatrix = String(properties?.riskMatrixColor ?? '').toLowerCase();
  return WARNING_LEVELS.includes(fromMatrix) ? fromMatrix : null;
}

function intervalMs(when) {
  const [start, end] = Array.isArray(when?.interval) ? when.interval : [];
  const onset = Date.parse(start);
  const expires = Date.parse(end);
  return {
    onset: Number.isFinite(onset) ? onset : null,
    expires: Number.isFinite(expires) ? expires : null,
  };
}

/**
 * @param {object} geojson MetAlerts `current.json` payload.
 * @returns {Array<object> | null} Rows, or null when the payload is not a feature collection.
 */
export function normalizeWeatherWarningSnapshot(geojson) {
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
    // A cancellation retracts an earlier warning; it is not itself a hazard.
    if (properties.type === 'Cancel') continue;
    const stableId = text(properties.id);
    const level = warningLevel(properties);
    if (!stableId || !level || ids.has(stableId)) continue;
    const polygons = normalizePolygons(feature.geometry);
    if (polygons === null || !polygons.length) continue;
    ids.add(stableId);
    const { onset, expires } = intervalMs(feature.when);
    rows.push({
      stableId,
      source: 'met',
      level,
      event: text(properties.event),
      eventName: text(properties.eventAwarenessName),
      area: text(properties.area),
      domain: properties.geographicDomain === 'marine' ? 'marine' : 'land',
      severity: text(properties.severity),
      certainty: text(properties.certainty),
      description: text(properties.description),
      instruction: text(properties.instruction),
      consequences: text(properties.consequences),
      web: /^https:\/\//.test(properties.web ?? '') ? properties.web : null,
      onset,
      expires,
      polygons,
    });
  }
  return rows;
}
