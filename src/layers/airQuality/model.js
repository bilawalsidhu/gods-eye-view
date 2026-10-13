import * as Cesium from 'cesium';

export const AIR_QUALITY_OVERLAY_SOURCE_ID = 'air-quality';
export const AIR_QUALITY_OVERLAY_COHORT_LIMIT = 96;
export const AIR_QUALITY_OVERLAY_COLLISION_CAPACITY = 48;

/**
 * Return Cesium.Color by US EPA Air Quality Index (AQI):
 *  - 0-50 (Good): Emerald Green
 *  - 51-100 (Moderate): Warm Yellow
 *  - 101-150 (Unhealthy Sensitive): Amber / Orange
 *  - 151-200 (Unhealthy): Red
 *  - 201-300 (Very Unhealthy): Purple
 *  - 301+ (Hazardous): Maroon
 * @param {number} aqi
 * @returns {Cesium.Color}
 */
export function aqiColor(aqi) {
  const val = Number(aqi) || 0;
  if (val <= 50) return Cesium.Color.fromCssColorString('#00ff88');
  if (val <= 100) return Cesium.Color.fromCssColorString('#ffdd00');
  if (val <= 150) return Cesium.Color.fromCssColorString('#ff9500');
  if (val <= 200) return Cesium.Color.fromCssColorString('#ff3b30');
  if (val <= 300) return Cesium.Color.fromCssColorString('#af52de');
  return Cesium.Color.fromCssColorString('#7e0023');
}

/**
 * Build ambient world overlay entry for one air quality monitoring point.
 * @param {object} input
 * @param {string} input.id
 * @param {Cesium.Cartesian3} input.position
 * @param {string} input.name
 * @param {number} input.aqi
 * @param {string} [input.pollutant]
 * @param {string} input.accent
 * @returns {object}
 */
export function createAirQualityOverlayEntry({
  id,
  position,
  name,
  aqi,
  pollutant = 'PM2.5',
  accent,
}) {
  const score = Math.max(0, Math.round(Number(aqi) || 0));
  return {
    id: String(id),
    position,
    variant: 'label',
    title: `AQI ${score}`,
    subtitle: pollutant,
    accent,
    priority: score * 100,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 12,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Filter and sort top air quality observations by priority (highest AQI / worst air first).
 * @param {Array<object>} entries
 * @param {number} [limit=AIR_QUALITY_OVERLAY_COHORT_LIMIT]
 * @returns {Array<object>}
 */
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
 * Map raw air quality observation to JSON-safe analyst record.
 * @param {object} raw
 * @param {number} [index=0]
 * @returns {object}
 */
export function mapAnalystRecord(raw, index = 0) {
  if (!raw || typeof raw !== 'object') {
    return {
      id: `station-${index}`,
      name: 'Unknown Station',
      city: null,
      country: null,
      lat: null,
      lon: null,
      aqi: null,
      category: null,
      primaryPollutant: null,
      pm25: null,
      pm10: null,
      no2: null,
      so2: null,
      time: null,
    };
  }

  return {
    id: raw.id != null ? String(raw.id) : `station-${index}`,
    name: raw.name != null ? String(raw.name) : 'Air Quality Station',
    city: raw.city != null ? String(raw.city) : null,
    country: raw.country != null ? String(raw.country) : null,
    industrialType:
      raw.industrialType != null ? String(raw.industrialType) : null,
    lat: Number.isFinite(raw.lat) ? Number(raw.lat.toFixed(5)) : null,
    lon: Number.isFinite(raw.lon) ? Number(raw.lon.toFixed(5)) : null,
    aqi: Number.isFinite(raw.aqi) ? Math.round(raw.aqi) : null,
    category: raw.category != null ? String(raw.category) : null,
    primaryPollutant:
      raw.primaryPollutant != null ? String(raw.primaryPollutant) : 'PM2.5',
    pm25: Number.isFinite(raw.pm25) ? Number(raw.pm25.toFixed(1)) : null,
    pm10: Number.isFinite(raw.pm10) ? Number(raw.pm10.toFixed(1)) : null,
    no2: Number.isFinite(raw.no2) ? Number(raw.no2.toFixed(1)) : null,
    so2: Number.isFinite(raw.so2) ? Number(raw.so2.toFixed(1)) : null,
    time: raw.time != null ? String(raw.time) : null,
  };
}
