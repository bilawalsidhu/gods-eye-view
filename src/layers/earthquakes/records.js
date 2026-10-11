/** Validate a complete feed before replacing the last good earthquake snapshot. */
export function normalizeEarthquakeSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const [index, feature] of geojson.features.entries()) {
    const coordinates = feature?.geometry?.coordinates;
    const properties = feature?.properties;
    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties) ||
      (feature.geometry.type != null && feature.geometry.type !== 'Point')
    )
      return null;
    const [lon, lat, depthKm] = coordinates;
    const mag = properties.mag;
    if (
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180 ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      (depthKm != null && !Number.isFinite(depthKm)) ||
      (mag != null && (!Number.isFinite(mag) || mag > 10))
    )
      return null;
    // A missing magnitude cannot establish that this event meets M2.5+.
    if (mag == null || mag < 2.5) continue;
    const stableId =
      feature.id == null || feature.id === ''
        ? `event-${index + 1}`
        : String(feature.id);
    if (ids.has(stableId)) return null;
    ids.add(stableId);
    rows.push({
      stableId,
      usgsId: feature.id ?? null,
      lon,
      lat,
      depthKm: depthKm ?? null,
      mag,
      place: typeof properties.place === 'string' ? properties.place : null,
      time: Number.isFinite(properties.time) ? properties.time : null,
    });
  }
  return rows;
}

/**
 * EMSC event types kept as earthquakes: known, suspected and induced
 * earthquakes (and untyped events). Quarry blasts, explosions and other
 * non-tectonic events are dropped.
 */
const EMSC_EARTHQUAKE_TYPES = new Set(['ke', 'se', 'ki', 'si']);

/** "NORTHERN NORWAY" -> "Northern Norway"; mixed-case names are kept. */
function regionName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text !== text.toUpperCase()) return text;
  return text
    .toLowerCase()
    .replace(
      /(^|[\s(/-])(\p{L})/gu,
      (_, lead, letter) => lead + letter.toUpperCase(),
    );
}

/**
 * Validate an EMSC SeismicPortal FDSN `format=json` feed into the same row
 * shape as USGS, M2.5+ earthquakes only. A malformed feed returns null.
 * @param {object} geojson EMSC FeatureCollection.
 * @returns {Array<object> | null}
 */
export function normalizeEmscSnapshot(geojson) {
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
      return null;
    const { lon, lat, depth, mag } = properties;
    if (
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180 ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      (depth != null && !Number.isFinite(depth)) ||
      (mag != null && (!Number.isFinite(mag) || mag > 10))
    )
      return null;
    const type = properties.evtype;
    if (type != null && type !== '' && !EMSC_EARTHQUAKE_TYPES.has(type))
      continue;
    if (mag == null || mag < 2.5) continue;
    const unid = properties.unid ?? feature.id;
    if (unid == null || unid === '') return null;
    const stableId = `emsc:${unid}`;
    if (ids.has(stableId)) return null;
    ids.add(stableId);
    const time = Date.parse(properties.time);
    rows.push({
      stableId,
      usgsId: null,
      emscId: String(unid),
      lon,
      lat,
      depthKm: depth ?? null,
      mag,
      place: regionName(properties.flynn_region),
      time: Number.isFinite(time) ? time : null,
    });
  }
  return rows;
}

const EARTH_RADIUS_KM = 6371;
/**
 * The same event in two catalogs: origin times and epicentres this close.
 * Catalogs may disagree on the origin time by minutes for a nearly identical
 * epicentre (a West Texas event: 2 km apart, 235 s apart), so a close pair
 * gets a wider time window.
 */
export const DUPLICATE_WINDOWS = Object.freeze([
  Object.freeze({ seconds: 90, km: 150 }),
  Object.freeze({ seconds: 300, km: 25 }),
]);

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * USGS rows, then the EMSC rows USGS does not already report. Large events
 * appear in both catalogs with slightly different solutions; an EMSC event
 * within any of DUPLICATE_WINDOWS of a USGS event is the same event and is
 * dropped.
 * @param {Array<object>} usgsRows
 * @param {Array<object>} emscRows
 * @returns {Array<object>}
 */
export function mergeEarthquakeSnapshots(usgsRows = [], emscRows = []) {
  const merged = [...usgsRows];
  for (const row of emscRows) {
    const duplicate = usgsRows.some((usgs) => {
      if (!Number.isFinite(usgs.time) || !Number.isFinite(row.time))
        return false;
      const seconds = Math.abs(usgs.time - row.time) / 1000;
      const km = distanceKm(usgs, row);
      return DUPLICATE_WINDOWS.some(
        (limit) => seconds <= limit.seconds && km <= limit.km,
      );
    });
    if (!duplicate) merged.push(row);
  }
  return merged;
}
