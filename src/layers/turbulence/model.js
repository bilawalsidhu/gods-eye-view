/** Turbulence layer constants and filters. Pure — no i18n catalog, no Cesium. */

export const TURBULENCE_LAYER_ID = 'weather-turbulence';

/** Severity colours, light to extreme; the legend lists them in this order. */
export const TURBULENCE_BANDS = Object.freeze([
  Object.freeze({ id: 'light', color: '#ffd54f' }),
  Object.freeze({ id: 'moderate', color: '#ff9800' }),
  Object.freeze({ id: 'severe', color: '#f44336' }),
  Object.freeze({ id: 'extreme', color: '#d500f9' }),
]);
const COLOR_BY_SEVERITY = Object.freeze(
  Object.fromEntries(TURBULENCE_BANDS.map((band) => [band.id, band.color])),
);

/** CSS colour of a severity; moderate for anything unknown. */
export const severityColor = (severity) =>
  COLOR_BY_SEVERITY[severity] ?? COLOR_BY_SEVERITY.moderate;

/**
 * What is shown: severities (severe includes extreme), altitudes either side
 * of FL180, and the three products. All on unless the viewer turns one off.
 */
export const DEFAULT_TURBULENCE_FILTERS = Object.freeze({
  light: true,
  moderate: true,
  severe: true,
  low: true,
  high: true,
  forecasts: true,
  warnings: true,
  reports: true,
});

/** The filter groups and their keys, in the order the panel shows them. */
export const TURBULENCE_FILTER_GROUPS = Object.freeze({
  severity: Object.freeze(['light', 'moderate', 'severe']),
  altitude: Object.freeze(['low', 'high']),
  sources: Object.freeze(['forecasts', 'warnings', 'reports']),
});

/**
 * Apply `params` (booleans keyed as DEFAULT_TURBULENCE_FILTERS) to `filters`.
 * Other keys and non-boolean values are ignored.
 * @returns {{filters: object, changed: boolean}}
 */
export function applyTurbulenceFilters(filters, params) {
  const next = { ...filters };
  let changed = false;
  for (const key of Object.keys(DEFAULT_TURBULENCE_FILTERS)) {
    if (typeof params?.[key] !== 'boolean' || next[key] === params[key])
      continue;
    next[key] = params[key];
    changed = true;
  }
  return { filters: changed ? Object.freeze(next) : filters, changed };
}

const SOURCE_OF_KIND = Object.freeze({
  forecast: 'forecasts',
  warning: 'warnings',
  report: 'reports',
});

/** Whether a record passes the filters. */
export function passesTurbulenceFilters(record, filters) {
  if (!filters[SOURCE_OF_KIND[record.kind]]) return false;
  const severity = record.severity === 'extreme' ? 'severe' : record.severity;
  if (!filters[severity]) return false;
  if (record.band === 'low') return filters.low;
  if (record.band === 'high') return filters.high;
  return filters.low || filters.high;
}
