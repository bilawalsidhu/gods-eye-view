/**
 * @module layers/aqhi/model
 *
 * The Canadian Air Quality Health Index: banding, published form, colour ramp,
 * and snapshot validation. Pure — no Cesium, no network.
 *
 * AQHI is a health-risk index, not a pollutant concentration. Environment and
 * Climate Change Canada reports it as an INTEGER from 1 to 10, with anything
 * above 10 reported as the open-ended category "10+". The API returns a decimal
 * (1.08, 2.32), which is the underlying computed value — publishing that
 * decimal as-is would invent a precision the index does not claim, so
 * `aqhiDisplayValue` rounds to the published form and floors at 1.
 *
 * Bands follow ECCC's published health-risk categories:
 *   1-3 Low · 4-6 Moderate · 7-10 High · above 10 Very High
 */

/** ECCC health-risk bands, in ascending severity. */
export const AQHI_BANDS = Object.freeze([
  Object.freeze({ id: 'low', label: 'Low', max: 3, color: '#4cc9f0' }),
  Object.freeze({
    id: 'moderate',
    label: 'Moderate',
    max: 6,
    color: '#ffd43b',
  }),
  Object.freeze({ id: 'high', label: 'High', max: 10, color: '#ff6b35' }),
  Object.freeze({
    id: 'very-high',
    label: 'Very High',
    max: Infinity,
    color: '#c1121f',
  }),
]);

/** Colour used when a station reports no usable reading. */
export const AQHI_UNKNOWN_COLOR = '#6b7785';

export const AQHI_OVERLAY_SOURCE_ID = 'aqhi';
export const AQHI_OVERLAY_COHORT_LIMIT = 48;
export const AQHI_OVERLAY_COLLISION_CAPACITY = 32;

/**
 * A reading this old is stale enough that displaying it would misinform.
 * AQHI publishes hourly; six hours means five missed publications.
 */
export const OBSERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The published AQHI value for a raw reading: an integer from 1 up, or null.
 *
 * ECCC reports whole numbers with a floor of 1 — there is no "AQHI 0" and no
 * "AQHI 1.08". A raw value below 1 is a legitimate low reading, not an error,
 * and is published as 1.
 *
 * @param {number|string|null|undefined} raw - Raw `aqhi` value from the API.
 * @returns {number|null} Published integer AQHI, or null when unusable.
 */
export function aqhiDisplayValue(raw) {
  // Guard the empty forms BEFORE coercing: Number(null) and Number('') are both
  // 0, which would otherwise floor to a confident "AQHI 1" for a station that
  // reported nothing at all.
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.max(1, Math.round(value));
}

/**
 * The health-risk band for a reading.
 * @param {number|string|null|undefined} raw
 * @returns {object|null} Band descriptor, or null when unusable.
 */
export function aqhiBand(raw) {
  const value = aqhiDisplayValue(raw);
  if (value === null) return null;
  return (
    AQHI_BANDS.find((band) => value <= band.max) ||
    AQHI_BANDS[AQHI_BANDS.length - 1]
  );
}

/**
 * Accent colour for a reading, falling back to neutral grey when absent.
 * @param {number|string|null|undefined} raw
 * @returns {string} CSS hex colour.
 */
export function aqhiColor(raw) {
  return aqhiBand(raw)?.color || AQHI_UNKNOWN_COLOR;
}

/**
 * Label text for a marker: the published value, with "+" above 10.
 * @param {number|string|null|undefined} raw
 * @returns {string} e.g. "3", "10+", or "--" when there is no reading.
 */
export function aqhiLabel(raw) {
  const value = aqhiDisplayValue(raw);
  if (value === null) return '--';
  return value > 10 ? '10+' : String(value);
}

/**
 * Plain-language risk phrase for a reading, for cards and voice.
 * @param {number|string|null|undefined} raw
 * @returns {string|null} e.g. "Low health risk", or null when unusable.
 */
export function aqhiRiskText(raw) {
  const band = aqhiBand(raw);
  return band ? `${band.label} health risk` : null;
}

/**
 * Validate a station FeatureCollection into an id-keyed catalog.
 *
 * Atomic: a structurally broken response returns null so the caller keeps its
 * last good catalog. A station missing coordinates is skipped, since one
 * unusable station is not evidence the catalog is broken.
 *
 * @param {object} geojson - GeoJSON FeatureCollection from `aqhi-stations`.
 * @returns {Map<string, object>|null} Stations by location_id, or null.
 */
export function normalizeAqhiStations(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const stations = new Map();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      return null;
    const coordinates = feature?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const [lon, lat] = coordinates.map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const id = String(properties.location_id ?? feature.id ?? '').trim();
    if (!id) continue;
    stations.set(id, {
      id,
      name: String(properties.location_name_en || id).trim(),
      // ECCC's own administrative zone: atl, que, ont, pnr, pyr. Retained so a
      // consumer can group or filter regionally without a boundary polygon.
      zone: String(properties['eccc_administrative-zone'] || '').trim(),
      lat,
      lon,
    });
  }
  return stations;
}

/**
 * Join latest observations onto known stations, newest reading per station.
 *
 * Observations arriving for stations absent from the catalog are dropped: the
 * catalog is what supplies each reading its coordinates, so a reading without
 * one cannot be placed on the globe. Readings older than
 * OBSERVATION_MAX_AGE_MS are dropped too — a six-hour-old air-quality number
 * presented as current is worse than no number.
 *
 * @param {object} geojson - FeatureCollection from `aqhi-observations-realtime`.
 * @param {Map<string, object>} stations - Known stations by location_id.
 * @param {number} [now=Date.now()] - Clock seam for tests.
 * @returns {Array<object>|null} Normalized readings, or null when malformed.
 */
export function normalizeAqhiObservations(geojson, stations, now = Date.now()) {
  if (!Array.isArray(geojson?.features)) return null;
  if (!(stations instanceof Map)) return null;
  const newest = new Map();
  for (const feature of geojson.features) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      return null;
    const stationId = String(properties.location_id ?? '').trim();
    const station = stations.get(stationId);
    if (!station) continue;

    const value = aqhiDisplayValue(properties.aqhi);
    if (value === null) continue;
    const observedMs = Date.parse(properties.observation_datetime);
    if (!Number.isFinite(observedMs)) continue;
    if (now - observedMs > OBSERVATION_MAX_AGE_MS) continue;

    const previous = newest.get(stationId);
    if (previous && previous.observedMs >= observedMs) continue;
    newest.set(stationId, {
      stationId,
      name: station.name,
      zone: station.zone,
      lat: station.lat,
      lon: station.lon,
      aqhi: value,
      observedMs,
      color: aqhiColor(properties.aqhi),
      label: aqhiLabel(properties.aqhi),
      risk: aqhiRiskText(properties.aqhi),
      note: String(properties.special_notes_en || '').trim() || null,
    });
  }
  return [...newest.values()].sort(
    (a, b) => b.aqhi - a.aqhi || a.stationId.localeCompare(b.stationId),
  );
}

/**
 * Build the source-owned presentation for one AQHI station label.
 * @param {object} input
 * @returns {object}
 */
export function createAqhiOverlayEntry({ id, position, title, accent, aqhi }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    // Worse air wins the label budget — the reading people need to see first.
    priority: Math.round(Number(aqhi) || 0) * 1000,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the worst readings, with stable identity as the tie-break. */
export function selectAqhiOverlayCohort(
  entries,
  limit = AQHI_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(AQHI_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Map one reading to a JSON-safe analyst record. Pure — no Cesium types.
 * @param {object|null|undefined} raw
 * @param {number} [index=0]
 * @returns {object}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  return {
    id: text(raw?.stationId) || `AQHI-${String(index).padStart(4, '0')}`,
    name: text(raw?.name),
    zone: text(raw?.zone),
    aqhi: num(raw?.aqhi),
    risk: text(raw?.risk),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    observedMs: num(raw?.observedMs),
  };
}
