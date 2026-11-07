import { formatNumber, getLocale, isolate, msg, t } from '../i18n/index.js';
import {
  distanceParts,
  METRES_PER_FOOT,
  METRES_PER_MILE,
} from '../data/distanceFormat.js';

// Unit ids stay English in data, params and AI-tool readings; only the label
// shown on the page is translated. dBZ, °C and °F read the same in every
// language.
const UNIT_LABELS = Object.freeze({
  'km/h': msg('km/h'),
  'km/s': msg('km/s'),
  'm/s': msg('m/s'),
  mph: msg('mph'),
  hPa: msg('hPa'),
  kt: msg('kt'),
  kts: msg('kts'),
  ft: msg('ft'),
  mi: msg('mi'),
  km: msg('km'),
  m: msg('m'),
  'km²': msg('km²'),
  'mi²': msg('mi²'),
  h: msg('h'),
  min: msg('min'),
  s: msg('s'),
  dB: msg('dB'),
});

/** The display label for a unit id; unknown units pass through unchanged. */
export function unitLabel(unit) {
  return Object.hasOwn(UNIT_LABELS, unit) ? t(UNIT_LABELS[unit]) : unit || '';
}

/**
 * What goes between a number and its unit label: a no-break space, except
 * before a Japanese unit word, which follows the number directly (5分, 1時間).
 */
export function quantitySeparator(label) {
  return getLocale() === 'ja' &&
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(label)
    ? ''
    : '\u00a0';
}

/**
 * A number and its unit that never break apart: "22,0 км/ч". Readings carry
 * no digit grouping ("1008 hPa"), as on weather charts.
 */
export function formatQuantity(value, unit, options) {
  const label = unitLabel(unit);
  const number = formatNumber(value, { useGrouping: false, ...options });
  return label
    ? isolate(`${number}${quantitySeparator(label)}${label}`)
    : number;
}

// ---------------------------------------------------------------------------
// Unit system. The page shows measurements in metric or imperial units; data,
// share links, stored values and AI-tool payloads stay SI. The choice is kept
// per browser (Display → Units) and read by every converting formatter below.
// ---------------------------------------------------------------------------

/** The unit systems the page can show. */
export const UNIT_SYSTEMS = Object.freeze(['metric', 'imperial']);

/** Where the browser keeps the choice. */
export const UNIT_SYSTEM_STORAGE_KEY = 'gev:units:v1';

/** `'metric'`, `'imperial'`, or null for anything else. */
export function normalizeUnitSystem(value) {
  const system = String(value ?? '')
    .trim()
    .toLowerCase();
  return UNIT_SYSTEMS.includes(system) ? system : null;
}

// The page's unit system. The UI binds it to a Vue ref (src/ui/i18n.js), so
// a view that formats a measurement re-renders when it changes; until then,
// and in portable code, it is plain state.
let pageUnitSystem = { value: 'metric' };
let unitSystemBound = false;
const unitSystemListeners = new Set();

/**
 * Keep the unit system in `ref`, a Vue ref. It takes the current system;
 * switch with setUnitSystem afterwards.
 * @param {{value: string}} ref
 */
export function bindUnitSystem(ref) {
  ref.value = pageUnitSystem.value;
  pageUnitSystem = ref;
  unitSystemBound = true;
}

/** The active unit system: `'metric'` or `'imperial'`. */
export function getUnitSystem() {
  return normalizeUnitSystem(pageUnitSystem.value) || 'metric';
}

/**
 * Call `listener` after the unit system changes, so code that shows text it
 * formatted itself shows it again. A Vue view that formats while rendering
 * follows without this.
 * @param {() => void} listener
 * @returns {() => void} Stops listening.
 */
export function onUnitSystemChange(listener) {
  if (typeof listener !== 'function') return () => {};
  unitSystemListeners.add(listener);
  return () => unitSystemListeners.delete(listener);
}

/**
 * Tell the listeners the unit system changed. setUnitSystem does this for an
 * unbound system; the owner of a bound ref calls it when the ref changes.
 */
export function notifyUnitSystemChange() {
  for (const listener of [...unitSystemListeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[units] unit system listener failed', error);
    }
  }
}

/**
 * Switch the unit system; unknown values select metric.
 * @returns {'metric'|'imperial'} The system applied.
 */
export function setUnitSystem(system) {
  const next = normalizeUnitSystem(system) || 'metric';
  if (pageUnitSystem.value !== next) {
    pageUnitSystem.value = next;
    if (!unitSystemBound) notifyUnitSystemChange();
  }
  return next;
}

/**
 * The unit system for this visit: the browser's stored choice, otherwise
 * metric, whatever the browser's language. Storage is injectable for tests.
 * @returns {'metric'|'imperial'}
 */
export function resolveUnitSystem({ storage } = {}) {
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    const stored = normalizeUnitSystem(
      store?.getItem?.(UNIT_SYSTEM_STORAGE_KEY),
    );
    if (stored) return stored;
  } catch {
    // Unavailable storage falls back to metric.
  }
  return 'metric';
}

/** Keep the choice for the next visit; false when storage is unavailable. */
export function persistUnitSystem(system, { storage } = {}) {
  const next = normalizeUnitSystem(system) || 'metric';
  try {
    const store = storage !== undefined ? storage : globalThis.localStorage;
    if (typeof store?.setItem !== 'function') return false;
    store.setItem(UNIT_SYSTEM_STORAGE_KEY, next);
    return true;
  } catch {
    return false;
  }
}

const KM_PER_MILE = METRES_PER_MILE / 1000;

// Metric unit → [imperial unit, conversion]. Aviation feet, flight levels and
// knots, nautical miles, hPa, dB and dBZ have no entry: they read the same in
// both systems.
const IMPERIAL = Object.freeze({
  km: ['mi', (value) => value / KM_PER_MILE],
  m: ['ft', (value) => value / METRES_PER_FOOT],
  'km/h': ['mph', (value) => value / KM_PER_MILE],
  'm/s': ['mph', (value) => (value * 3600) / METRES_PER_MILE],
  'km/s': ['mph', (value) => (value * 3600) / KM_PER_MILE],
  '°C': ['°F', (value) => (value * 9) / 5 + 32],
  'km²': ['mi²', (value) => value / (KM_PER_MILE * KM_PER_MILE)],
  mm: ['in', (value) => value / 25.4],
});

/** A reading that can be shown: a finite number, never null, '' or NaN. */
function finite(value) {
  return (
    value !== null &&
    value !== '' &&
    typeof value !== 'boolean' &&
    Number.isFinite(Number(value))
  );
}

/**
 * A metric value in the active unit system: `{value: 6.2, unit: 'mi'}` for
 * 10 km under imperial. Units without an imperial counterpart, and every
 * unit under metric, come back as given.
 * @param {number} value
 * @param {string} unit A metric unit id: km, m, km/h, m/s, km/s, °C, km², mm.
 * @param {'metric'|'imperial'} [system]
 * @returns {{value: number, unit: string}}
 */
export function convertQuantity(value, unit, system = getUnitSystem()) {
  const imperial = system === 'imperial' && IMPERIAL[unit];
  return imperial
    ? { value: imperial[1](Number(value)), unit: imperial[0] }
    : { value: Number(value), unit };
}

/** The unit `unit` is shown in under the active system: km → mi. */
export function displayUnit(unit, system = getUnitSystem()) {
  return convertQuantity(0, unit, system).unit;
}

/**
 * formatQuantity for a metric reading in the active unit system:
 * `formatMeasure(10, 'km')` is "10 km", or "6 mi" under imperial. The number
 * is whole unless `options` (Intl options for the number shown) say
 * otherwise. Missing or non-numeric readings read "—" (never "0" or "NaN").
 * @param {number} value
 * @param {string} unit
 * @param {Intl.NumberFormatOptions} [options]
 * @returns {string}
 */
export function formatMeasure(value, unit, options) {
  if (!finite(value)) return '—';
  const shown = convertQuantity(value, unit);
  const digits =
    options?.maximumFractionDigits ?? options?.minimumFractionDigits ?? 0;
  // Round to what prints first, so a reading just below zero shows "0",
  // never "-0".
  const rounded = Math.round(shown.value * 10 ** digits) / 10 ** digits || 0;
  return formatQuantity(rounded, shown.unit, {
    ...options,
    maximumFractionDigits: digits,
  });
}

/**
 * A distance in the active unit system with the precision of `distanceParts`:
 * "850 m", "4.6 km", "21 km", or "820 ft", "2.9 mi", "13 mi". Never broken
 * apart; "—" for a missing or negative distance.
 * @param {number} meters
 * @param {{metreStep?: number, exactBelowM?: number}} [options]
 * @returns {string}
 */
export function formatDistance(meters, options) {
  const parts = finite(meters)
    ? distanceParts(Number(meters), { ...options, system: getUnitSystem() })
    : null;
  if (!parts) return '—';
  return formatQuantity(parts.value, parts.unit, {
    minimumFractionDigits: parts.digits,
    maximumFractionDigits: parts.digits,
  });
}

/**
 * A speed in metres per second as km/h, or mph under imperial, whole unless
 * `options` say otherwise ("—" when unknown).
 * @param {number} metresPerSecond
 * @param {Intl.NumberFormatOptions} [options]
 */
export function formatSpeed(metresPerSecond, options) {
  if (!finite(metresPerSecond)) return '—';
  return formatMeasure(Number(metresPerSecond) * 3.6, 'km/h', options);
}

/**
 * A temperature in °C, or °F under imperial, whole unless `options` say
 * otherwise ("—" when unknown). Below zero keeps its sign: "-3 °C", "27 °F".
 * @param {number} celsius
 * @param {Intl.NumberFormatOptions} [options]
 */
export function formatTemperature(celsius, options) {
  return formatMeasure(celsius, '°C', options);
}

/**
 * A length in the compact style of camera readouts: "120m", or "394ft" under
 * imperial units, in the active language ("120 м"). Whole unless `digits`
 * says otherwise; "—" when unknown.
 * @param {number} meters
 * @param {number} [digits]
 */
export function formatCompactLength(meters, digits = 0) {
  if (!finite(meters)) return '—';
  const shown = convertQuantity(meters, 'm');
  const rounded = Math.round(shown.value * 10 ** digits) / 10 ** digits || 0;
  const value = formatNumber(rounded, {
    useGrouping: false,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return shown.unit === 'ft'
    ? t('{value}ft', { value })
    : t('{value}m', { value });
}

/**
 * A measurement upper-cased the HUD way (`9.5 KM`, `120 MPH`), except in
 * Chinese and Japanese, which keep units as the catalog writes them.
 * @param {string} text
 */
export function unitCase(text) {
  return /^(zh|ja)(-|$)/.test(getLocale()) ? text : text.toUpperCase();
}

/**
 * An area in km², or mi² under imperial ("—" when unknown).
 * @param {number} squareKilometres
 * @param {Intl.NumberFormatOptions} [options]
 */
export function formatArea(squareKilometres, options) {
  return formatMeasure(squareKilometres, 'km²', options);
}

/**
 * A legend stop such as "0.1", "-40" or "300+" in the active language.
 * Anything that is not a plain number is shown as given. In right-to-left
 * text the stop is isolated, so its sign stays where it is written ("300+",
 * "-40") instead of moving to the other side of the number.
 */
export function formatScaleLabel(label) {
  const match = /^(-?\d+(?:\.\d+)?)(\+?)$/.exec(String(label ?? ''));
  if (!match) return String(label ?? '');
  const decimals = match[1].split('.')[1]?.length || 0;
  return isolate(
    `${formatNumber(Number(match[1]), {
      useGrouping: false,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })}${match[2]}`,
  );
}

// Legend units whose stops the page converts. A wind-speed legend follows
// the wind layer's own unit chips instead.
const CONVERTED_SCALES = new Set(['°C']);

/** A scale's unit as shown: °F for a °C scale under imperial. */
function scaleUnit(units) {
  return CONVERTED_SCALES.has(units) ? displayUnit(units) : units;
}

/** A metric legend stop ("-40", "50+") in the active unit system. */
function convertScaleLabel(label, units) {
  const match = /^(-?\d+(?:\.\d+)?)(\+?)$/.exec(String(label ?? ''));
  if (!match || scaleUnit(units) === units) return label;
  const decimals = match[1].split('.')[1]?.length || 0;
  const value = convertQuantity(Number(match[1]), units).value;
  const rounded = Math.round(value * 10 ** decimals) / 10 ** decimals || 0;
  return `${rounded.toFixed(decimals)}${match[2]}`;
}

/**
 * A legend range with its unit: "960 — 1050+ hPa". The unit stays with the
 * last number. In right-to-left text the unit is isolated as well, so a Latin
 * unit keeps its own order ("°C", not "C°"). Units a source supplied as data
 * (`verbatim`) are shown as given; a metric unit the page converts ("°C")
 * shows its stops in the active unit system ("-40 — 122+ °F").
 */
export function formatScaleRange(low, high, units, verbatim = false) {
  const shownLow = verbatim ? low : convertScaleLabel(low, units);
  const shownHigh = verbatim ? high : convertScaleLabel(high, units);
  const unit = verbatim ? units || '' : unitLabel(scaleUnit(units));
  const range = `${formatScaleLabel(shownLow)} — ${formatScaleLabel(shownHigh)}`;
  return unit ? `${range}\u00a0${isolate(unit)}` : range;
}
