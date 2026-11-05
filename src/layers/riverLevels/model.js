/**
 * @module layers/riverLevels/model
 *
 * River gauge readings, normalized across national networks. Pure — no
 * Cesium, no network — so the server normalizers and the layer share it.
 *
 * A gauge reads the water against its own zero: 0.81 m at Bonn and 154 m at a
 * Taiwanese hill station say nothing about each other. A reading therefore
 * never gets a colour from its value. It gets one only from the references
 * its own operator publishes for that gauge (Germany's lowest-ever and mean
 * levels and flood alert stages, Taiwan's three alert levels, Canada's means
 * of the yearly lowest and highest daily levels), mapped into
 * one shared set of bands. A gauge without references stays grey.
 */
// A portable export: no i18n here. The labels stay English data; the layer
// shows them translated.
const msg = (text) => text;

/** Shared bands, in display order from driest to most severe flood. */
export const RIVER_LEVEL_BANDS = Object.freeze([
  Object.freeze({
    id: 'record-low',
    label: msg('Lowest on record'),
    color: '#b8621b',
    severity: 4,
  }),
  Object.freeze({
    id: 'low',
    label: msg('Below normal'),
    color: '#d9b77a',
    severity: 2,
  }),
  Object.freeze({
    id: 'normal',
    label: msg('Normal'),
    color: '#4cc9f0',
    severity: 1,
  }),
  Object.freeze({
    id: 'watch',
    label: msg('Watch'),
    color: '#ffd43b',
    severity: 3,
  }),
  Object.freeze({
    id: 'warning',
    label: msg('Warning'),
    color: '#ff8c1a',
    severity: 5,
  }),
  Object.freeze({
    id: 'flood',
    label: msg('Flood'),
    color: '#e8364a',
    severity: 6,
  }),
  Object.freeze({
    id: 'major',
    label: msg('Above record high'),
    color: '#d63384',
    severity: 7,
  }),
  Object.freeze({
    id: 'unknown',
    label: msg('No reference levels'),
    color: '#7b8794',
    severity: 0,
  }),
]);

const BAND_BY_ID = new Map(RIVER_LEVEL_BANDS.map((band) => [band.id, band]));

/** Band descriptor for an id; unknown ids read as "no reference levels". */
export function riverBandById(id) {
  return BAND_BY_ID.get(String(id ?? '')) || BAND_BY_ID.get('unknown');
}

/** Severity rank for sorting (higher is worse; floods outrank droughts). */
export const riverBandSeverity = (id) => riverBandById(id).severity;

/** Bands that earn a pulse on the globe: water over the flood line. */
export const PULSING_BANDS = Object.freeze(new Set(['flood', 'major']));

/**
 * Reference levels a gauge may publish, in metres on that gauge's own zero.
 * `recordLow`/`recordHigh` are the lowest and highest levels ever observed,
 * `low`/`mean`/`high` the long-term means of the yearly lows, of all days and
 * of the yearly highs, and `watch`/`warning`/`flood` the operator's own alert
 * stages in ascending severity.
 */
export const REFERENCE_KEYS = Object.freeze([
  'recordLow',
  'low',
  'mean',
  'high',
  'watch',
  'warning',
  'flood',
  'recordHigh',
]);

const finite = (value) =>
  value !== null && value !== '' && Number.isFinite(Number(value))
    ? Number(value)
    : null;

/**
 * Keep the finite references only. Alert stages that are not strictly
 * ascending (watch < warning < flood) are an operator data error: the stages
 * are dropped rather than guessed, and the gauge falls back to its other
 * references or stays grey.
 * @param {Record<string, unknown>} refs
 * @returns {Record<string, number>}
 */
export function cleanReferences(refs = {}) {
  const out = {};
  for (const key of REFERENCE_KEYS) {
    const value = finite(refs?.[key]);
    if (value !== null) out[key] = value;
  }
  const stages = ['watch', 'warning', 'flood'].filter((key) => key in out);
  for (let i = 1; i < stages.length; i++) {
    if (!(out[stages[i]] > out[stages[i - 1]])) {
      for (const key of stages) delete out[key];
      break;
    }
  }
  return out;
}

/**
 * The band for a level against its gauge's references (metres, same zero).
 * Alert stages win over climatology: a gauge above its operator's first alert
 * stage is on watch whatever its long-term mean says.
 * @param {number} level
 * @param {Record<string, number>} refs Cleaned references.
 * @returns {string} Band id.
 */
export function classifyRiverLevel(level, refs = {}) {
  if (!Number.isFinite(level)) return 'unknown';
  const r = refs || {};
  if (r.recordHigh !== undefined && level > r.recordHigh) return 'major';
  if (r.flood !== undefined && level >= r.flood) return 'flood';
  if (r.warning !== undefined && level >= r.warning) return 'warning';
  if (r.watch !== undefined && level >= r.watch) return 'watch';
  // Without its own alert stages, a gauge above its mean yearly high is the
  // closest published sign of high water.
  if (r.watch === undefined && r.high !== undefined && level > r.high)
    return 'watch';
  if (r.recordLow !== undefined && level <= r.recordLow) return 'record-low';
  if (r.low !== undefined && level < r.low) return 'low';
  const hasReference = [
    'low',
    'mean',
    'high',
    'watch',
    'warning',
    'flood',
  ].some((key) => r[key] !== undefined);
  return hasReference ? 'normal' : 'unknown';
}

/** Change below this rate reads as steady (cm per hour). */
export const TREND_STEADY_CM_PER_HOUR = 1;

/** 'rising', 'falling', 'steady', or null when no rate is known. */
export function trendDirection(cmPerHour) {
  if (!Number.isFinite(cmPerHour)) return null;
  if (cmPerHour > TREND_STEADY_CM_PER_HOUR) return 'rising';
  if (cmPerHour < -TREND_STEADY_CM_PER_HOUR) return 'falling';
  return 'steady';
}

/** Readings this old are drawn dimmed and marked late. */
export const READING_LATE_AFTER_MS = 3 * 60 * 60 * 1000;
/** Readings this old are not drawn: the gauge has stopped reporting. */
export const READING_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** The layer reports itself stale when its newest reading is this old. */
export const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** Is one reading late (observed long enough ago to dim it)? */
export function readingIsLate(station, now = Date.now()) {
  const at = Number(station?.observedMs);
  return !Number.isFinite(at) || now - at > READING_LATE_AFTER_MS;
}

/** The newest observation time across stations, or null. */
export function newestObservation(stations) {
  let newest = null;
  for (const station of stations || []) {
    const at = Number(station?.observedMs);
    if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/**
 * Stage height for the 3D column, as a fraction where 0.88 is the flood line.
 *
 * The column shows how close the water is to the gauge's own references, not
 * a depth: each published reference sits at a fixed height, and the level is
 * interpolated between the two it falls between. Below the lowest reference
 * the slope of the lowest segment continues, so a gauge with alert stages only
 * still drops visibly when the river is low.
 */
const ANCHOR_HEIGHTS = Object.freeze({
  recordLow: 0.06,
  low: 0.2,
  mean: 0.36,
  high: 0.56,
  watch: 0.62,
  warning: 0.75,
  flood: 0.88,
  recordHigh: 1,
});
/** Height of the ring drawn on every column: the flood line. */
export const FLOOD_LINE_FRACTION = ANCHOR_HEIGHTS.flood;
const FRACTION_MIN = 0.03;
const FRACTION_MAX = 1.15;

/**
 * @param {number} level
 * @param {Record<string, number>} refs Cleaned references.
 * @returns {number|null} Fraction, or null when fewer than two references.
 */
export function stageFraction(level, refs = {}) {
  if (!Number.isFinite(level)) return null;
  const anchors = [];
  for (const key of REFERENCE_KEYS) {
    if (refs?.[key] !== undefined)
      anchors.push([refs[key], ANCHOR_HEIGHTS[key]]);
  }
  anchors.sort((a, b) => a[0] - b[0]);
  // A reference whose height breaks the order (a mean yearly high above the
  // first alert stage, say) cannot be drawn honestly; drop it.
  const ordered = [];
  for (const anchor of anchors) {
    const last = ordered.at(-1);
    if (!last || (anchor[0] > last[0] && anchor[1] > last[1]))
      ordered.push(anchor);
  }
  if (ordered.length < 2) return null;
  let i = 1;
  while (i < ordered.length - 1 && level > ordered[i][0]) i++;
  const [v0, h0] = ordered[i - 1];
  const [v1, h1] = ordered[i];
  const fraction = h0 + ((level - v0) * (h1 - h0)) / (v1 - v0);
  return Math.min(FRACTION_MAX, Math.max(FRACTION_MIN, fraction));
}

/** Registered networks. `coverage` is stated plainly: the layer is not global. */
export const RIVER_LEVEL_PROVIDERS = Object.freeze({
  pegelonline: Object.freeze({
    id: 'pegelonline',
    country: 'DE',
    network: 'PEGELONLINE (WSV)',
    coverage: msg('Germany · federal waterways'),
    licence: 'DL-DE Zero 2.0',
  }),
  wra: Object.freeze({
    id: 'wra',
    country: 'TW',
    network: 'Water Resources Agency (WRA)',
    coverage: msg('Taiwan · central rivers'),
    licence: 'Open Government Data License, version 1.0',
  }),
  eccc: Object.freeze({
    id: 'eccc',
    country: 'CA',
    network: 'Water Survey of Canada (ECCC)',
    coverage: msg('Canada · real-time hydrometric network'),
    licence: 'ECCC Data Servers End-use Licence',
  }),
  rws: Object.freeze({
    id: 'rws',
    country: 'NL',
    network: 'Rijkswaterstaat',
    coverage: msg('Netherlands · national waters'),
    licence: 'Reuse with source and date (rijkswaterstaatdata.nl)',
    datum: 'NAP',
  }),
});

/** Same stable id shape the server publishes: `<provider>:<code>`. */
export const STATION_ID_PATTERN =
  /^(pegelonline:[0-9a-f-]{36}|wra:[0-9A-Z]{4,12}|eccc:[0-9]{2}[A-Z]{2}[0-9]{3}|rws:[a-z0-9][a-z0-9._-]{1,80})$/;

/**
 * The official page for a gauge, built from its validated code only.
 * @returns {string|null}
 */
export function stationPageUrl(station) {
  const code = String(station?.code ?? '');
  if (station?.provider === 'pegelonline' && /^[0-9]{5,10}$/.test(code))
    return `https://www.pegelonline.wsv.de/gast/stammdaten?pegelnr=${code}`;
  if (station?.provider === 'eccc' && /^[0-9]{2}[A-Z]{2}[0-9]{3}$/.test(code))
    return `https://wateroffice.ec.gc.ca/report/real_time_e.html?stn=${code}`;
  return null;
}

/**
 * Stations inside a lon/lat rectangle (degrees), most severe first, then the
 * fastest change. A rectangle crossing the antimeridian has east < west.
 */
export function stationsInView(stations, rect, limit = 5) {
  if (!Array.isArray(stations) || !rect) return [];
  const inLon = (lon) =>
    rect.west <= rect.east
      ? lon >= rect.west && lon <= rect.east
      : lon >= rect.west || lon <= rect.east;
  return stations
    .filter(
      (s) =>
        s.lat >= rect.south &&
        s.lat <= rect.north &&
        inLon(s.lon) &&
        s.band !== 'unknown',
    )
    .sort(compareSeverity)
    .slice(0, limit);
}

/** Most severe first, then the fastest change, then a stable id order. */
export function compareSeverity(a, b) {
  return (
    riverBandSeverity(b.band) - riverBandSeverity(a.band) ||
    Math.abs(b.trend ?? 0) - Math.abs(a.trend ?? 0) ||
    String(a.id).localeCompare(String(b.id))
  );
}

const BLOCKS = '▁▂▃▄▅▆▇█';

/**
 * A text sparkline: one block character per column, each the mean of the
 * values that fall in it. Text, because world-overlay cards draw lines of text.
 * @param {Array<[number, number]>} points [epochMs, value] in time order.
 * @param {number} [columns=36]
 * @returns {string}
 */
export function sparkline(points, columns = 36) {
  const values = (points || []).filter(
    (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
  );
  if (values.length < 2) return '';
  const start = values[0][0];
  const span = values.at(-1)[0] - start || 1;
  const sums = new Array(columns).fill(0);
  const counts = new Array(columns).fill(0);
  for (const [at, value] of values) {
    const column = Math.min(
      columns - 1,
      Math.floor(((at - start) / span) * columns),
    );
    sums[column] += value;
    counts[column] += 1;
  }
  const means = sums.map((sum, i) => (counts[i] ? sum / counts[i] : null));
  // A column with no reading repeats its neighbour, so a gap reads as flat.
  for (let i = 0; i < columns; i++)
    if (means[i] === null) means[i] = means[i - 1] ?? null;
  const present = means.filter((v) => v !== null);
  const min = Math.min(...present);
  const max = Math.max(...present);
  return means
    .map((v) =>
      v === null
        ? ' '
        : BLOCKS[
            max === min
              ? 3
              : Math.round(((v - min) / (max - min)) * (BLOCKS.length - 1))
          ],
    )
    .join('');
}

/** Metres on the gauge's own zero, to the centimetre. */
export function formatLevel(metres) {
  if (!Number.isFinite(metres)) return '—';
  return `${metres.toFixed(2)} m`;
}

/** Signed rate label, e.g. "+12 cm/h". */
export function formatTrend(cmPerHour) {
  if (!Number.isFinite(cmPerHour)) return null;
  const rounded = Math.round(cmPerHour);
  return `${rounded > 0 ? '+' : rounded < 0 ? '−' : '±'}${Math.abs(rounded)} cm/h`;
}

/** JSON-safe analyst record for one station. */
export function mapAnalystRecord(station) {
  return {
    id: station.id,
    name: station.name,
    river: station.river,
    provider: station.provider,
    band: station.band,
    levelM: station.level,
    trendCmPerHour: station.trend ?? null,
    observedMs: station.observedMs,
    lat: station.lat,
    lon: station.lon,
  };
}
