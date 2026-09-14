export function createModel({ state: layerState, services, parts, source }) {
  /**
   * Coerce a GBFS boolean field to a native boolean.
   * GBFS feeds are inconsistent — some use booleans, others use 0/1 or strings.
   * @param {*} value - Raw field value from GBFS JSON.
   * @param {boolean} [fallback=true] - Default when value is null/undefined/unrecognized.
   * @returns {boolean}
   */

  function normalizeGbfsBool(value, fallback = true) {
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

  function toNonNegativeInteger(value, fallback = null) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.round(n);
  }

  /**
   * Build a globally unique render key for a station.
   * @param {string} cityId - City identifier.
   * @param {string} stationId - Station identifier within the city.
   * @returns {string} Composite key in "cityId:stationId" format.
   */

  function stationKey(cityId, stationId) {
    return `${cityId}:${stationId}`;
  }

  /**
   * Compute the great-circle distance between two points using the Haversine formula.
   * @param {number} aLat - Latitude of point A in degrees.
   * @param {number} aLon - Longitude of point A in degrees.
   * @param {number} bLat - Latitude of point B in degrees.
   * @param {number} bLon - Longitude of point B in degrees.
   * @returns {number} Distance in kilometers.
   */

  function haversineKm(aLat, aLon, bLat, bLon) {
    const toRad = (value) => (value * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLon = toRad(bLon - aLon);
    const p1 = toRad(aLat);
    const p2 = toRad(bLat);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Extract the stations array from a GBFS JSON payload.
   * Handles multiple response shapes: { data: { stations: [...] } },
   * { data: [...] }, and nested objects with a stations sub-key.
   * @param {Object} payload - Parsed GBFS JSON response.
   * @returns {Object[]} Array of raw station objects (may be empty).
   */

  function extractStationsArray(payload) {
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
   * Parse a GBFS station_information payload into a Map of station metadata.
   * Handles field-name variations across different GBFS providers
   * (station_id vs id, lat vs latitude, etc.). Stations with missing or
   * invalid coordinates are silently skipped.
   * @param {Object} payload - Parsed station_information.json response.
   * @returns {Map<string, Object>} Map of stationId to station info objects.
   */

  function parseStationInformation(payload) {
    const stations = extractStationsArray(payload);
    const stationMap = new Map();

    for (const raw of stations) {
      // Accept both GBFS 2.x (station_id) and alternate (id) field names
      const stationId = String(raw?.station_id ?? raw?.id ?? '').trim();
      const lat = Number(raw?.lat ?? raw?.latitude);
      const lon = Number(raw?.lon ?? raw?.longitude);
      if (!stationId || !Number.isFinite(lat) || !Number.isFinite(lon))
        continue;

      stationMap.set(stationId, {
        stationId,
        name: String(raw?.name || raw?.short_name || '').trim(),
        lat,
        lon,
        capacity: toNonNegativeInteger(raw?.capacity),
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

  function parseStationStatus(payload) {
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
  return {
    normalizeGbfsBool,
    toNonNegativeInteger,
    stationKey,
    haversineKm,
    extractStationsArray,
    parseStationInformation,
    parseStationStatus,
  };
}
