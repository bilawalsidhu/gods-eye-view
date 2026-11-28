/**
 * @module layers/airQuality/model
 *
 * Air-quality readings, normalized across networks. Pure — no Cesium, no
 * network.
 *
 * A reading is carried as `{ provider, scale, value, band }` — who measured
 * it, what the value is on (a pollutant's concentration, or the US AQI the
 * layer computes from concentrations, `usAqi.js`), the value itself and its
 * band.
 */
import {
  ambientLabelEntry,
  topByPriority,
} from '../../data/ambientLabelOverlay.js';
import { concentrationIn, layerUnits } from './units.js';
// usAqi.js imports this module too; both read the other's bindings only inside functions.
import { AQI_PARAMETERS } from './usAqi.js';

/** Colour used when a station reports no usable reading. */
export const AIR_QUALITY_UNKNOWN_COLOR = '#6b7785';

/** The colour of a station no index rates. */
export const AIR_QUALITY_UNRATED_COLOR = '#8cb4ce';

export const AIR_QUALITY_OVERLAY_SOURCE_ID = 'air-quality';
export const AIR_QUALITY_OVERLAY_COHORT_LIMIT = 48;
export const AIR_QUALITY_OVERLAY_COLLISION_CAPACITY = 32;

/**
 * A reading this old is stale enough that displaying it would misinform.
 * Networks publish hourly, so six hours is five missed publications.
 */
export const OBSERVATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * How old the newest observation may be before the layer reports itself stale.
 *
 * This is deliberately separate from the age at which a reading is dropped.
 * `lastUpdate` records when we last *received* a response, which stays current
 * even when the network publishes nothing new; freshness has to be judged on
 * the source's own observation time instead. Networks publish hourly, so a
 * newest reading beyond two hours means at least one publication was missed and
 * the feed should not be described as live.
 */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * The newest observation time across a set of readings, or null when empty.
 * @param {Array<object>} readings
 * @returns {number|null} Epoch ms.
 */
export function newestObservation(readings) {
  if (!Array.isArray(readings) || readings.length === 0) return null;
  let newest = null;
  for (const reading of readings) {
    const at = Number(reading?.observedMs);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Is a set of readings stale, judged on source observation time? An empty
 * set is stale: a refresh that kept no current observation has nothing live.
 * @param {Array<object>} readings
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
export function readingsAreStale(readings, now = Date.now()) {
  const newest = newestObservation(readings);
  // No current observation at all — every row was dropped as too old or
  // unusable — is the stalest a feed can be, not a nominal one.
  if (newest === null) return true;
  return now - newest > STALE_AFTER_MS;
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
  return ambientLabelEntry({
    id,
    position,
    title,
    accent,
    // Worse air wins the label budget — the reading people need to see first.
    priority: Math.round(Number(value) || 0) * 1000,
    gapPx: 14,
  });
}

/** Keep the worst readings, with stable identity as the tie-break. */
export function selectAirQualityOverlayCohort(
  entries,
  limit = AIR_QUALITY_OVERLAY_COHORT_LIMIT,
) {
  return topByPriority(entries, limit, AIR_QUALITY_OVERLAY_COHORT_LIMIT);
}

/** Whether a reading lies inside a lon/lat rectangle; a null rectangle holds everything. */
export function isInRectangle(reading, rect) {
  if (!rect) return true;
  if (reading.lat < rect.south || reading.lat > rect.north) return false;
  // A rectangle crossing the antimeridian has west > east.
  return rect.west <= rect.east
    ? reading.lon >= rect.west && reading.lon <= rect.east
    : reading.lon >= rect.west || reading.lon <= rect.east;
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
  // Only comparable readings have a value in the layer's units.
  const pollutant = raw?.kind === 'observation' && raw.parameter !== 'aqi';
  const comparable = raw?.qualityFlagged !== true;
  const converted =
    pollutant && comparable
      ? concentrationIn(raw.parameter, raw.value, raw.units)
      : null;
  return {
    id: text(raw?.id) || `AIR-${String(index).padStart(4, '0')}`,
    provider: text(raw?.provider),
    scale: text(raw?.scale),
    value: pollutant ? converted : comparable ? num(raw?.value) : null,
    band: text(raw?.band),
    name: text(raw?.name),
    zone: text(raw?.zone),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    observedMs: num(raw?.observedMs),
    ...(raw?.kind === 'observation'
      ? {
          parameter: text(raw.parameter),
          units:
            converted !== null
              ? layerUnits(raw.parameter)
              : pollutant
                ? null
                : text(raw.units),
          ...(pollutant
            ? { reportedValue: num(raw.value), reportedUnits: text(raw.units) }
            : {}),
          averagingMinutes: num(raw.averagingMinutes),
          kind: 'observation',
          country: text(raw.country),
          owner: text(raw.owner),
          note: text(raw.note),
          assessment: raw.assessment ?? null,
          // The AQI view's computed index: its category, the pollutant
          // leading it and the values it used (µg/m³; CO mg/m³).
          ...(raw.parameter === 'aqi'
            ? {
                ...Object.fromEntries(
                  Object.entries(raw.aqiValues ?? {}).filter(
                    ([id, v]) =>
                      Object.hasOwn(AQI_PARAMETERS, id) && Number.isFinite(v),
                  ),
                ),
                aqi: raw.aqi
                  ? {
                      index: num(raw.aqi.index),
                      category: text(raw.aqi.category),
                      leading: text(raw.aqi.leading),
                      values: { ...(raw.aqiValues ?? {}) },
                    }
                  : null,
              }
            : {}),
        }
      : {}),
  };
}
