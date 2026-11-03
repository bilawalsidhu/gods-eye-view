/** Parse GBFS station documents, tolerating field-name variations across providers. */

/**
 * Coerce a GBFS boolean field to a native boolean.
 * GBFS feeds are inconsistent — some use booleans, others use 0/1 or strings.
 * @param {*} value - Raw field value from GBFS JSON.
 * @param {boolean} [fallback=true] - Default when value is null/undefined/unrecognized.
 * @returns {boolean}
 */
export function normalizeGbfsBool(value, fallback = true) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const num = Number(value);
  if (Number.isFinite(num)) return num !== 0;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === 'yes') return true;
  if (text === 'false' || text === 'no') return false;
  return fallback;
}

/**
 * Parse a value as a non-negative integer, returning fallback on failure.
 * @param {*} value - Raw numeric value.
 * @param {number|null} [fallback=null] - Returned when value is not a valid non-negative number.
 * @returns {number|null}
 */
export function toNonNegativeInteger(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
}

/**
 * Extract the stations array from a GBFS JSON payload.
 * Handles multiple response shapes: { data: { stations: [...] } },
 * { data: [...] }, and nested objects with a stations sub-key.
 * @param {Object} payload - Parsed GBFS JSON response.
 * @returns {Object[]} Array of raw station objects (may be empty).
 */
export function extractStationsArray(payload) {
  const data = payload?.data;
  if (Array.isArray(data?.stations)) return data.stations;
  if (Array.isArray(data)) return data;
  // Some feeds nest stations under an additional key (e.g. locale wrappers)
  if (data && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (Array.isArray(value?.stations)) return value.stations;
    }
  }
  return [];
}

/**
 * Station name text as a reader expects it. JCDecaux's Spanish contracts
 * (Valenbisi, Sevici) prefix every name with "_" and Valenbisi joins words
 * with it ("_PLAZA_MUSICO_LOPEZ_CHAVARRI"), so an underscore reads as a word
 * break. Other spacing is the operator's own and stays as published.
 */
function tidyStationName(text) {
  return text.replace(/\s*_+\s*/g, ' ').trim();
}

/** Read legacy text or a GBFS v3 Localized String, preferring usable English text. */
function stationName(value) {
  if (typeof value === 'string') return tidyStationName(value);
  if (!Array.isArray(value)) return '';

  let fallback = '';
  for (const translation of value) {
    if (typeof translation?.text !== 'string') continue;
    const text = tidyStationName(translation.text);
    if (!text) continue;
    if (!fallback) fallback = text;
    if (
      typeof translation.language === 'string' &&
      /^en(?:-|$)/i.test(translation.language.trim())
    )
      return text;
  }
  return fallback;
}

/**
 * Docks a station physically has. PBSC adds the bikes a station accepts in its
 * geofenced area around the docks to `capacity` and reports that part as
 * `geofenced_capacity` (not a GBFS field): Bilbao Bizi publishes 39 docks as
 * capacity 839 with geofenced_capacity 800. Without the extension, or when it
 * would exceed the total, `capacity` is read as given. PBSC also counts the
 * bikes parked in that area (`num_bikes_overflow`) in `num_bikes_available`, so
 * a crowded station can report more bikes than docks.
 */
function dockCapacity(raw) {
  const capacity = toNonNegativeInteger(raw?.capacity);
  const geofenced = toNonNegativeInteger(raw?.geofenced_capacity);
  if (capacity == null || geofenced == null || geofenced > capacity)
    return capacity;
  return capacity - geofenced;
}

/** Read a numeric coordinate without treating blank text or other JSON types as zero. */
function coordinateNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim()))
    return NaN;
  return Number(value);
}

/**
 * Parse a GBFS station_information payload into a Map of station metadata.
 * Handles field-name variations across different GBFS providers
 * (station_id vs id, lat vs latitude, etc.). Stations with missing or
 * invalid coordinates are silently skipped.
 * @param {Object} payload - Parsed station_information.json response.
 * @returns {Map<string, Object>} Map of stationId to station info objects.
 */
export function parseStationInformation(payload) {
  const stations = extractStationsArray(payload);
  const stationMap = new Map();

  for (const raw of stations) {
    // Accept both GBFS (station_id) and alternate (id) field names
    const stationId = String(raw?.station_id ?? raw?.id ?? '').trim();
    const lat = coordinateNumber(raw?.lat ?? raw?.latitude);
    const lon = coordinateNumber(raw?.lon ?? raw?.longitude);
    if (
      !stationId ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    )
      continue;

    stationMap.set(stationId, {
      stationId,
      name: stationName(raw?.name) || stationName(raw?.short_name),
      lat,
      lon,
      capacity: dockCapacity(raw),
      isInstalled: normalizeGbfsBool(raw?.is_installed, true),
      isRenting: normalizeGbfsBool(raw?.is_renting, true),
      isReturning: normalizeGbfsBool(raw?.is_returning, true),
    });
  }

  return stationMap;
}

/**
 * Parse a GBFS station_status payload into a Map of real-time availability.
 * @param {Object} payload - Parsed station_status.json response.
 * @returns {Map<string, Object>} Map of stationId to status objects containing
 *   bikesAvailable, docksAvailable, and operational flags.
 */
export function parseStationStatus(payload) {
  const stations = extractStationsArray(payload);
  const statusMap = new Map();

  for (const raw of stations) {
    const stationId = String(raw?.station_id ?? raw?.id ?? '').trim();
    if (!stationId) continue;

    const bikes = toNonNegativeInteger(raw?.num_bikes_available);
    const docks = toNonNegativeInteger(raw?.num_docks_available);
    statusMap.set(stationId, {
      stationId,
      bikesAvailable: bikes,
      docksAvailable: docks,
      isInstalled: normalizeGbfsBool(raw?.is_installed, true),
      isRenting: normalizeGbfsBool(raw?.is_renting, true),
      isReturning: normalizeGbfsBool(raw?.is_returning, true),
      lastReported: toNonNegativeInteger(raw?.last_reported),
    });
  }

  return statusMap;
}
