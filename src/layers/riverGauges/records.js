import { msg } from '../../i18n/marker.js';

/**
 * NWS flood categories as the layer draws them, most severe first. Colours
 * follow the NWS hydrograph legend for the four flood stages (action yellow,
 * minor orange, moderate red, major purple); a gauge below flood stage is a
 * quiet green, and a gauge without a current, defined reading is grey.
 * `inFlood` marks action stage and above, which the layer draws larger.
 */
export const RIVER_GAUGE_CATEGORIES = Object.freeze(
  [
    {
      id: 'major',
      label: msg('Major flooding'),
      color: '#cc33ff',
      size: 15,
      inFlood: true,
    },
    {
      id: 'moderate',
      label: msg('Moderate flooding'),
      color: '#ff2020',
      size: 13,
      inFlood: true,
    },
    {
      id: 'minor',
      label: msg('Minor flooding'),
      color: '#ff9900',
      size: 11,
      inFlood: true,
    },
    {
      id: 'action',
      label: msg('Near flood stage (action)'),
      color: '#ffee00',
      size: 9,
      inFlood: true,
    },
    {
      id: 'low_threshold',
      label: msg('Below low-water threshold'),
      color: '#a0784a',
      size: 6,
      inFlood: false,
    },
    {
      id: 'no_flooding',
      label: msg('Below flood stage'),
      color: '#4f9a6a',
      size: 5,
      inFlood: false,
    },
    {
      id: 'not_defined',
      label: msg('No flood stages defined'),
      color: '#7f8c99',
      size: 4,
      inFlood: false,
      dim: true,
    },
    {
      id: 'obs_not_current',
      label: msg('Reading not current'),
      color: '#6b7178',
      size: 4,
      inFlood: false,
      dim: true,
    },
    {
      id: 'out_of_service',
      label: msg('Out of service'),
      color: '#555b61',
      size: 4,
      inFlood: false,
      dim: true,
    },
  ].map((category, rank) => Object.freeze({ ...category, rank })),
);

const BY_ID = new Map(RIVER_GAUGE_CATEGORIES.map((c) => [c.id, c]));
/** Forecast-only category: the forecast is not current. */
const FORECAST_ONLY = new Set(['fcst_not_current']);

/**
 * The drawn category for an observed category id; anything unknown reads as
 * "no flood stages defined", never as a flood.
 * @param {string} id NWPS category id.
 */
export function riverGaugeCategory(id) {
  return BY_ID.get(id) || BY_ID.get('not_defined');
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);
const textOrNull = (value, max = 160) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const timeOrNull = (value) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : null;

function status(raw, { forecast = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const category = String(raw.category || '');
  return {
    stage: finiteOrNull(raw.stage),
    stageUnit: textOrNull(raw.stageUnit, 8),
    flow: finiteOrNull(raw.flow),
    flowUnit: textOrNull(raw.flowUnit, 8),
    category:
      BY_ID.has(category) || (forecast && FORECAST_ONLY.has(category))
        ? category
        : 'not_defined',
    time: timeOrNull(raw.time),
  };
}

/**
 * Validate the `/api/nwps/gauges` snapshot into layer records. Rows without
 * an id or a position are dropped; null when the payload is not a snapshot.
 * @param {object} payload Server snapshot.
 * @returns {{gauges: Array<object>, generatedAt: string|null, stale: boolean,
 *   failedRegions: number}|null}
 */
export function normalizeRiverGaugeSnapshot(payload) {
  if (!payload || !Array.isArray(payload.gauges)) return null;
  const gauges = [];
  for (const raw of payload.gauges) {
    const lid = typeof raw?.lid === 'string' ? raw.lid : '';
    if (!/^[A-Z]{4}[0-9]$/.test(lid)) continue;
    if (
      !Number.isFinite(raw.lat) ||
      !Number.isFinite(raw.lon) ||
      Math.abs(raw.lat) > 90 ||
      Math.abs(raw.lon) > 180
    )
      continue;
    const observed = status(raw.observed) || {
      stage: null,
      stageUnit: null,
      flow: null,
      flowUnit: null,
      category: 'not_defined',
      time: null,
    };
    gauges.push({
      id: `river-gauge:${lid}`,
      lid,
      name: textOrNull(raw.name) || lid,
      lat: raw.lat,
      lon: raw.lon,
      state: textOrNull(raw.state, 4),
      wfo: textOrNull(raw.wfo, 4),
      observed,
      forecast: status(raw.forecast, { forecast: true }),
    });
  }
  const failed = Array.isArray(payload.regions?.failed)
    ? payload.regions.failed.length
    : 0;
  return {
    gauges,
    generatedAt: timeOrNull(payload.generatedAt),
    stale: payload.stale === true,
    failedRegions: failed,
  };
}

/**
 * Whether a forecast is worth showing: NWPS issued one and it is current.
 * @param {object|null} forecast Normalised forecast status.
 */
export function forecastIsCurrent(forecast) {
  return Boolean(
    forecast &&
    forecast.time &&
    !FORECAST_ONLY.has(forecast.category) &&
    (forecast.stage !== null || forecast.flow !== null),
  );
}

/**
 * Gauges per observed category, every drawn category present.
 * @param {Array<object>} gauges Layer records.
 * @returns {Record<string, number>}
 */
export function countRiverGauges(gauges) {
  const counts = Object.fromEntries(
    RIVER_GAUGE_CATEGORIES.map((c) => [c.id, 0]),
  );
  for (const gauge of gauges)
    counts[riverGaugeCategory(gauge.observed.category).id]++;
  return counts;
}

/** Gauges at action stage or above. */
export function countGaugesInFlood(counts) {
  return RIVER_GAUGE_CATEGORIES.filter((c) => c.inFlood).reduce(
    (sum, c) => sum + (counts[c.id] || 0),
    0,
  );
}

/** The newest observation time among `gauges`, in epoch ms, or null. */
export function newestRiverGaugeObservation(gauges) {
  let newest = null;
  for (const gauge of gauges) {
    const ms = Date.parse(gauge.observed.time);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

/**
 * The NWPS page for a gauge, built from a validated id only.
 * @param {string} lid NWS location id.
 * @returns {string|null}
 */
export function riverGaugePageUrl(lid) {
  return /^[A-Z]{4}[0-9]$/.test(lid)
    ? `https://water.noaa.gov/gauges/${lid}`
    : null;
}

const FEET_PER_METRE = 3.28084;
const CFS_PER_CMS = 35.3147;
const round = (value, digits) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

/** A stage in feet, whichever length unit NWPS sent; null otherwise. */
export function toFeet(value, unit) {
  if (!Number.isFinite(value)) return null;
  if (unit === 'ft') return value;
  return unit === 'm' ? round(value * FEET_PER_METRE, 2) : null;
}

/** A flow in thousands of cubic feet per second; null for unknown units. */
export function toKcfs(value, unit) {
  if (!Number.isFinite(value)) return null;
  const cfs = {
    kcfs: value * 1000,
    cfs: value,
    cms: value * CFS_PER_CMS,
    kcms: value * 1000 * CFS_PER_CMS,
  }[unit];
  return cfs === undefined ? null : round(cfs / 1000, 4);
}

/**
 * One JSON-safe record for the analyst query engine.
 * @param {object} gauge Layer record.
 */
export function mapRiverGaugeAnalystRecord(gauge) {
  return {
    id: gauge.lid,
    name: gauge.name,
    state: gauge.state,
    category: gauge.observed.category,
    stageFt: toFeet(gauge.observed.stage, gauge.observed.stageUnit),
    flowKcfs: toKcfs(gauge.observed.flow, gauge.observed.flowUnit),
    observedMs: Number.isFinite(Date.parse(gauge.observed.time))
      ? Date.parse(gauge.observed.time)
      : null,
    lat: gauge.lat,
    lon: gauge.lon,
  };
}
