/**
 * @module layers/airQuality/model
 *
 * Air-quality readings, normalized across networks. Pure — no Cesium, no
 * network.
 *
 * Air-quality indices are not interchangeable numbers. Canada's AQHI runs 1 to
 * 10+ on health risk; the US AQI runs 0 to 500 on concentration breakpoints;
 * Europe's EAQI is a five-step category. A reading is therefore carried as
 * `{ provider, scale, value, band }` — who measured it, which index it is, the
 * value on that index's own terms, and the band it falls in — so a second
 * network can be added without retrofitting a shared numeric meaning that does
 * not exist.
 *
 * Only ECCC's AQHI is implemented here; `AIR_QUALITY_PROVIDERS` is the seam a
 * later provider registers against.
 */

/** Band identifiers shared across providers, in ascending severity. */
export const AIR_QUALITY_BANDS = Object.freeze([
  Object.freeze({ id: 'low', label: 'Low', color: '#4cc9f0' }),
  Object.freeze({ id: 'moderate', label: 'Moderate', color: '#ffd43b' }),
  Object.freeze({ id: 'high', label: 'High', color: '#ff6b35' }),
  Object.freeze({ id: 'very-high', label: 'Very High', color: '#c1121f' }),
]);

const BAND_BY_ID = new Map(AIR_QUALITY_BANDS.map((band) => [band.id, band]));

/** Colour used when a station reports no usable reading. */
export const AIR_QUALITY_UNKNOWN_COLOR = '#6b7785';

export const AIR_QUALITY_OVERLAY_SOURCE_ID = 'air-quality';
export const AIR_QUALITY_OVERLAY_COHORT_LIMIT = 48;
export const AIR_QUALITY_OVERLAY_COLLISION_CAPACITY = 32;

/**
 * A reading this old is stale enough that displaying it would misinform.
 * AQHI publishes hourly, so six hours is five missed publications.
 */
export const OBSERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Registered provider descriptors. `coverage` is stated plainly because the
 * layer is not global and the row must say so.
 */
export const AIR_QUALITY_PROVIDERS = Object.freeze({
  eccc: Object.freeze({
    id: 'eccc',
    scale: 'AQHI',
    label: 'Air quality',
    network: 'Environment and Climate Change Canada',
    coverage: 'Canada only · ECCC AQHI network',
    /** ECCC's published band thresholds, evaluated in order. */
    bands: Object.freeze([
      Object.freeze({ id: 'low', max: 3 }),
      Object.freeze({ id: 'moderate', max: 6 }),
      Object.freeze({ id: 'high', max: 10 }),
      Object.freeze({ id: 'very-high', max: Infinity }),
    ]),
  }),
});

/** Band descriptor for an id, or null. */
export function airQualityBandById(bandId) {
  return BAND_BY_ID.get(String(bandId ?? '')) || null;
}

/** Accent colour for a band id, falling back to neutral grey. */
export function airQualityColor(bandId) {
  return airQualityBandById(bandId)?.color || AIR_QUALITY_UNKNOWN_COLOR;
}

/**
 * The published AQHI value for a raw ECCC reading: an integer from 1 up.
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
 * The band id for a value on a provider's scale.
 * @param {string} providerId
 * @param {number|null} value - Already in the provider's published form.
 * @returns {string|null}
 */
export function bandForValue(providerId, value) {
  const provider = AIR_QUALITY_PROVIDERS[String(providerId ?? '')];
  if (!provider || !Number.isFinite(value)) return null;
  return provider.bands.find((band) => value <= band.max)?.id ?? null;
}

/**
 * Display text for a value on a provider's scale.
 * AQHI collapses everything above ten into the open-ended "10+".
 * @param {string} providerId
 * @param {number|null} value
 * @returns {string}
 */
export function valueLabel(providerId, value) {
  if (!Number.isFinite(value)) return '--';
  if (providerId === 'eccc') return value > 10 ? '10+' : String(value);
  return String(value);
}

/** Plain-language risk phrase for a band id. */
export function bandRiskText(bandId) {
  const band = airQualityBandById(bandId);
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
      // ECCC's administrative zone: atl, que, ont, pnr, pyr.
      zone: String(properties['eccc_administrative-zone'] || '').trim(),
      lat,
      lon,
    });
  }
  return stations;
}

/**
 * Join latest ECCC observations onto known stations into provider-shaped rows.
 *
 * The catalog is the only thing that supplies a reading its coordinates, so an
 * observation without a matching station cannot be placed and is dropped.
 * Readings older than OBSERVATION_MAX_AGE_MS are dropped too — a six-hour-old
 * air-quality number presented as current is worse than no number.
 *
 * @param {object} geojson - FeatureCollection from `aqhi-observations-realtime`.
 * @param {Map<string, object>} stations - Known stations by location_id.
 * @param {number} [now=Date.now()] - Clock seam for tests.
 * @returns {Array<object>|null} Normalized readings, or null when malformed.
 */
export function normalizeAqhiObservations(geojson, stations, now = Date.now()) {
  if (!Array.isArray(geojson?.features)) return null;
  if (!(stations instanceof Map)) return null;
  const provider = AIR_QUALITY_PROVIDERS.eccc;
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
    const band = bandForValue(provider.id, value);
    newest.set(stationId, {
      id: `${provider.id}:${stationId}`,
      provider: provider.id,
      scale: provider.scale,
      value,
      band,
      stationId,
      name: station.name,
      zone: station.zone,
      lat: station.lat,
      lon: station.lon,
      observedMs,
      color: airQualityColor(band),
      label: valueLabel(provider.id, value),
      risk: bandRiskText(band),
      note: String(properties.special_notes_en || '').trim() || null,
    });
  }
  return [...newest.values()].sort(
    (a, b) => b.value - a.value || a.stationId.localeCompare(b.stationId),
  );
}

/**
 * Build the source-owned presentation for one station label.
 * @param {object} input
 * @returns {object}
 */
export function createAirQualityOverlayEntry({
  id,
  position,
  title,
  accent,
  value,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    // Worse air wins the label budget — the reading people need to see first.
    priority: Math.round(Number(value) || 0) * 1000,
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
export function selectAirQualityOverlayCohort(
  entries,
  limit = AIR_QUALITY_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(AIR_QUALITY_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
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
 * The worst readings inside a lon/lat rectangle, for the readout card.
 *
 * A null rectangle means the camera could not resolve one (a fully oblique or
 * space-level view); everything is then in scope rather than nothing, so the
 * card degrades to the worst readings overall instead of going blank.
 *
 * @param {Array<object>} readings
 * @param {?{west:number, south:number, east:number, north:number}} rect - Degrees.
 * @param {number} [limit=5]
 * @returns {Array<object>}
 */
export function readingsInView(readings, rect, limit = 5) {
  if (!Array.isArray(readings)) return [];
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  if (cap === 0) return [];
  const inside = !rect
    ? readings
    : readings.filter((reading) => {
        if (reading.lat < rect.south || reading.lat > rect.north) return false;
        // A rectangle crossing the antimeridian has west > east.
        return rect.west <= rect.east
          ? reading.lon >= rect.west && reading.lon <= rect.east
          : reading.lon >= rect.west || reading.lon <= rect.east;
      });
  return inside
    .slice()
    .sort((a, b) => b.value - a.value || a.stationId.localeCompare(b.stationId))
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
    id: text(raw?.id) || `AIR-${String(index).padStart(4, '0')}`,
    provider: text(raw?.provider),
    scale: text(raw?.scale),
    value: num(raw?.value),
    band: text(raw?.band),
    name: text(raw?.name),
    zone: text(raw?.zone),
    risk: text(raw?.risk),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    observedMs: num(raw?.observedMs),
  };
}
