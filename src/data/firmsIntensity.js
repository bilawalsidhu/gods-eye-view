/**
 * @module firmsIntensity
 * @description Fire intensity policy shared by the Active Fires layer and the
 * agent fire tool: the six-stop cold → hot FRP color ramp, the log-scale
 * slider that doubles as its legend, and the one filter every consumer
 * (markers, cards, heat cells, the top-fires query, `get_active_fires`) runs
 * before anything is rendered or selected. Pure — no Cesium, no DOM.
 *
 * Hue order follows the Portolan FIRMS explorer (`FRP_RAMP`, stepped, not
 * interpolated). The thresholds are GEV's own, set on a real week's
 * percentiles so every color appears: Portolan's 0/10/50/200/500/1000 MW
 * leaves one red fire a week (HAL-675).
 */

/**
 * Stepped FRP ramp, coldest first. A detection takes the LAST stop whose
 * `minFrp` it reaches. Names key the glow-sprite cache and the card accents.
 */
export const FRP_RAMP = Object.freeze([
  Object.freeze({ name: 'blue', minFrp: 0, hex: '#4a5bd4' }),
  Object.freeze({ name: 'teal', minFrp: 5, hex: '#39a0a8' }),
  Object.freeze({ name: 'lime', minFrp: 20, hex: '#c9cf4a' }),
  Object.freeze({ name: 'amber', minFrp: 50, hex: '#f2b134' }),
  Object.freeze({ name: 'orange', minFrp: 100, hex: '#e8722c' }),
  Object.freeze({ name: 'red', minFrp: 300, hex: '#d1382a' }),
]);

/** Slider ticks: the ramp thresholds, so slider, legend and markers agree. */
export const FRP_SLIDER_TICKS = Object.freeze(
  FRP_RAMP.map((stop) => stop.minFrp),
);

/** Minimum-FRP values the share codec accepts, in whole megawatts. */
export const MIN_FRP_MW_MIN = 0;
export const MIN_FRP_MW_MAX = 10_000;

/** Confidence switch positions; VIIRS reports only low / nominal / high. */
export const FIRMS_CONFIDENCE_MODES = Object.freeze(['all', 'nominal', 'high']);

/**
 * Normalized-confidence floor for a switch position. The thresholds match
 * `confidenceBucket` in the layer model (0.3 / 0.6 / 0.9 after firmsAdapt).
 */
const CONFIDENCE_FLOOR = Object.freeze({ all: 0, nominal: 0.45, high: 0.75 });

export const DEFAULT_FIRE_FILTER = Object.freeze({
  minFrp: 0,
  confidence: 'all',
});

/**
 * The ramp stop for a fire radiative power.
 * @param {number} frp Megawatts; non-finite or negative reads as 0.
 * @returns {{name: string, minFrp: number, hex: string}}
 */
export function frpRampStop(frp) {
  const value = Number.isFinite(frp) ? Math.max(0, frp) : 0;
  let stop = FRP_RAMP[0];
  for (const candidate of FRP_RAMP) {
    if (value >= candidate.minFrp) stop = candidate;
    else break;
  }
  return stop;
}

/** `#rrggbb` → `[r, g, b]` in 0..255. */
export function hexToRgb(hex) {
  const text = String(hex).replace('#', '');
  return [0, 2, 4].map((offset) =>
    Number.parseInt(text.slice(offset, offset + 2), 16),
  );
}

/**
 * Log-scale slider axis: position 0 means "no minimum" (0 MW), and the rest
 * of the track runs 1 MW → SLIDER_MAX_MW logarithmically. The axis floor is 1
 * MW because the median detection is ~6 MW and a sub-megawatt floor hides
 * nothing worth a tick.
 */
export const SLIDER_MAX_MW = 1000;
const LOG_MAX = Math.log10(SLIDER_MAX_MW);

/**
 * Track position in 0..1 for a minimum FRP.
 * @param {number} minFrp Megawatts.
 * @returns {number}
 */
export function sliderPositionForFrp(minFrp) {
  if (!Number.isFinite(minFrp) || minFrp < 1) return 0;
  return Math.min(1, Math.log10(minFrp) / LOG_MAX);
}

/**
 * Minimum FRP for a track position, rounded to whole megawatts so a slider
 * value and its share-link form are the same number.
 * @param {number} position 0..1.
 * @returns {number}
 */
export function frpForSliderPosition(position) {
  const p = Number.isFinite(position) ? Math.max(0, Math.min(1, position)) : 0;
  if (p <= 0) return 0;
  const frp = Math.pow(10, p * LOG_MAX);
  return Math.max(1, Math.round(frp));
}

/**
 * CSS `linear-gradient` painting the stepped ramp along the log axis, so the
 * slider track IS the legend: the color under the thumb is the color of the
 * weakest fire still shown.
 * @returns {string}
 */
export function rampTrackGradient() {
  const parts = [];
  FRP_RAMP.forEach((stop, index) => {
    const start = sliderPositionForFrp(stop.minFrp) * 100;
    const next = FRP_RAMP[index + 1];
    const end = next ? sliderPositionForFrp(next.minFrp) * 100 : 100;
    parts.push(`${stop.hex} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/**
 * Minimum FRP → whole megawatts inside the codec bounds, or null.
 * @param {*} value
 * @returns {?number}
 */
export function normalizeMinFrp(value) {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(number)) return null;
  const rounded = Math.round(number);
  return rounded >= MIN_FRP_MW_MIN && rounded <= MIN_FRP_MW_MAX
    ? rounded
    : null;
}

/**
 * Confidence mode → one of FIRMS_CONFIDENCE_MODES, or null.
 * @param {*} value
 * @returns {?string}
 */
export function normalizeConfidenceMode(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return FIRMS_CONFIDENCE_MODES.includes(text) ? text : null;
}

/**
 * Sanitize a partial filter against the current one; unknown or invalid
 * fields keep their current value.
 * @param {Object} [params]
 * @param {{minFrp: number, confidence: string}} [current]
 * @returns {{minFrp: number, confidence: string}}
 */
export function normalizeFireFilter(
  params = {},
  current = DEFAULT_FIRE_FILTER,
) {
  const minFrp = normalizeMinFrp(params?.minFrp);
  const confidence = normalizeConfidenceMode(params?.confidence);
  return {
    minFrp: minFrp === null ? current.minFrp : minFrp,
    confidence: confidence === null ? current.confidence : confidence,
  };
}

/**
 * Whether one fire passes the filter. `confidence` is the normalized 0..1
 * value firmsAdapt produces; `frp` is megawatts.
 * @param {{frp: number, confidence: number}} fire
 * @param {{minFrp: number, confidence: string}} filter
 * @returns {boolean}
 */
export function firePassesFilter(fire, filter = DEFAULT_FIRE_FILTER) {
  const frp = Number.isFinite(fire?.frp) ? fire.frp : 0;
  if (frp < (filter.minFrp || 0)) return false;
  const floor = CONFIDENCE_FLOOR[filter.confidence] ?? 0;
  if (floor <= 0) return true;
  const confidence = Number.isFinite(fire?.confidence) ? fire.confidence : 0;
  return confidence >= floor;
}

/**
 * The fires that pass the filter, in input order. Returns the SAME array when
 * the filter is the default, so callers can tell "nothing hidden" cheaply.
 * @template T
 * @param {Array<T>} fires Internal records (normalized confidence).
 * @param {{minFrp: number, confidence: string}} filter
 * @returns {Array<T>}
 */
export function filterFires(fires, filter = DEFAULT_FIRE_FILTER) {
  if (!Array.isArray(fires)) return [];
  if (isDefaultFireFilter(filter)) return fires;
  return fires.filter((fire) => firePassesFilter(fire, filter));
}

/** True when the filter hides nothing. */
export function isDefaultFireFilter(filter) {
  return (
    !(filter?.minFrp > 0) &&
    (filter?.confidence === 'all' || filter?.confidence == null)
  );
}
