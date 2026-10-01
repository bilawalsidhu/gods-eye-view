/** Pure tide math for the coastal-tides layer. No Cesium, no DOM. */

export const TIDES_LAYER_ID = 'coastal-tides';
export const TIDE_WINDOW_BEFORE_MS = 12 * 3600_000;
export const TIDE_WINDOW_AFTER_MS = 48 * 3600_000;
export const METRES_PER_FOOT = 0.3048;

/**
 * Water level between two NOAA turning points. NOAA's own "hilo" product only
 * gives the turns; between them the curve is close to a half cosine, which is
 * the standard way tide tables are interpolated by hand.
 * @param {Array<{timeMs: number, height: number}>} turns sorted ascending
 * @param {number} timeMs
 * @returns {number|null} metres above MLLW, or null outside the covered span
 */
export function tideHeightAt(turns, timeMs) {
  if (!Array.isArray(turns) || turns.length < 2 || !Number.isFinite(timeMs))
    return null;
  if (timeMs < turns[0].timeMs || timeMs > turns.at(-1).timeMs) return null;
  let lo = 0;
  let hi = turns.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (turns[mid].timeMs <= timeMs) lo = mid;
    else hi = mid;
  }
  const a = turns[lo];
  const b = turns[hi];
  const span = b.timeMs - a.timeMs;
  if (span <= 0 || timeMs === a.timeMs) return a.height;
  if (timeMs === b.timeMs) return b.height;
  const f = (timeMs - a.timeMs) / span;
  return a.height + ((b.height - a.height) * (1 - Math.cos(Math.PI * f))) / 2;
}

/**
 * Direction of the tide and the next turning point.
 * @returns {{rising: boolean, next: {timeMs: number, height: number, type: string}}|null}
 */
export function tideTrendAt(turns, timeMs) {
  if (!Array.isArray(turns) || !Number.isFinite(timeMs)) return null;
  const index = turns.findIndex((turn) => turn.timeMs > timeMs);
  if (index <= 0) return null;
  const next = turns[index];
  return { rising: next.height > turns[index - 1].height, next };
}

/** The covered span of a prediction set, or null. */
export function tideSpan(turns) {
  if (!Array.isArray(turns) || turns.length < 2) return null;
  return { startMs: turns[0].timeMs, endMs: turns.at(-1).timeMs };
}

/**
 * Ellipsoid height (metres) of the water surface for a station.
 * @param {{mllwAboveNavd88: number, geoidN: number}} station
 * @param {number} tideM metres above MLLW
 * @param {{calibrationM?: number, extraM?: number}} [adjust]
 *   calibrationM: user correction for datum/terrain mismatch.
 *   extraM: wave runup or surge the user adds on top of the tide.
 */
export function waterEllipsoidHeight(
  station,
  tideM,
  { calibrationM = 0, extraM = 0 } = {},
) {
  return (
    tideM + station.mllwAboveNavd88 + station.geoidN + calibrationM + extraM
  );
}

/** Ellipsoid height of MLLW 0 at a station: the base the surface is built at. */
export function mllwEllipsoidHeight(station) {
  return station.mllwAboveNavd88 + station.geoidN;
}

export function formatFeet(metres, digits = 1) {
  if (!Number.isFinite(metres)) return '—';
  return `${(metres / METRES_PER_FOOT).toFixed(digits)} ft`;
}

export function formatSignedMetres(metres) {
  if (!Number.isFinite(metres)) return '—';
  const text = Math.abs(metres).toFixed(2);
  return `${metres < 0 ? '−' : '+'}${text} m`;
}

/** Local clock text in the station's zone, e.g. "Thu 1:39 PM". */
export function formatStationTime(timeMs, timeZone = 'America/Los_Angeles') {
  if (!Number.isFinite(timeMs)) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timeMs));
}
