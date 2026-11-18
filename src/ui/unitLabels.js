import { formatNumber, getLocale, isolate, msg, t } from '../i18n/index.js';
import { distanceParts } from '../data/distanceFormat.js';
import {
  FEET_PER_METRE,
  MM_PER_INCH,
  MPH_PER_KPH,
  celsiusToFahrenheit,
  usesImperial,
} from '../units.js';

// Unit ids stay English in data, params and AI-tool readings; only the label
// shown on the page is translated. dBZ, °C and °F read the same in every
// language.
const UNIT_LABELS = Object.freeze({
  'km/h': msg('km/h'),
  'm/s': msg('m/s'),
  mph: msg('mph'),
  hPa: msg('hPa'),
  kt: msg('kt'),
  kts: msg('kts'),
  ft: msg('ft'),
  mi: msg('mi'),
  mm: msg('mm'),
  km: msg('km'),
  m: msg('m'),
  h: msg('h'),
  min: msg('min'),
  s: msg('s'),
  dB: msg('dB'),
});

/** The display label for a unit id; unknown units pass through unchanged. */
export function unitLabel(unit) {
  // "in" alone is also the preposition, so the unit has its own entry.
  if (unit === 'in') return t('in', { context: 'unit of length' });
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

/**
 * A legend range with its unit: "960 — 1050+ hPa". The unit stays with the
 * last number. In right-to-left text the unit is isolated as well, so a Latin
 * unit keeps its own order ("°C", not "C°"). Units a source supplied as data
 * (`verbatim`) are shown as given.
 */
export function formatScaleRange(low, high, units, verbatim = false) {
  const unit = verbatim ? units || '' : unitLabel(units);
  const range = `${formatScaleLabel(low)} — ${formatScaleLabel(high)}`;
  return unit ? `${range}\u00a0${isolate(unit)}` : range;
}

// Quantities in the page's unit system (src/units.js). Each reads the system
// as it formats, so a view that calls one while rendering follows a switch.
// Readings for AI tools and share links keep their metric source values.

/** `21 °C` / `70 °F` from degrees Celsius; whole degrees unless `options` say. */
export function formatTemperature(celsius, options) {
  if (!Number.isFinite(celsius)) return '';
  return usesImperial()
    ? formatQuantity(
        celsiusToFahrenheit(celsius),
        '°F',
        wholeByDefault(options),
      )
    : formatQuantity(celsius, '°C', wholeByDefault(options));
}

/** A temperature in the page's system without its unit: 21 / 70. */
export function temperatureValue(celsius) {
  if (!Number.isFinite(celsius)) return null;
  return Math.round(usesImperial() ? celsiusToFahrenheit(celsius) : celsius);
}

/** `850 m` / `4.6 km`, or `920 ft` / `2.9 mi`: see distanceParts. */
export function formatDistance(meters, options) {
  const parts = distanceParts(meters, options);
  if (!parts) return '';
  return formatQuantity(parts.value, parts.unit, {
    minimumFractionDigits: parts.digits,
    maximumFractionDigits: parts.digits,
  });
}

/** A ground speed: `42 km/h` / `26 mph`, whole by default. */
export function formatRoadSpeed(kph, options) {
  if (!Number.isFinite(kph)) return '';
  return usesImperial()
    ? formatQuantity(kph * MPH_PER_KPH, 'mph', wholeByDefault(options))
    : formatQuantity(kph, 'km/h', wholeByDefault(options));
}

/** A height or elevation: `120 m` / `394 ft`, whole by default. */
export function formatHeight(meters, options) {
  if (!Number.isFinite(meters)) return '';
  return usesImperial()
    ? formatQuantity(meters * FEET_PER_METRE, 'ft', wholeByDefault(options))
    : formatQuantity(meters, 'm', wholeByDefault(options));
}

/** Rain or snow depth: `1.2 mm` / `0.05 in`. */
export function formatPrecipitation(mm) {
  if (!Number.isFinite(mm)) return '';
  return usesImperial()
    ? formatQuantity(mm / MM_PER_INCH, 'in', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    : formatQuantity(mm, 'mm', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
}

function wholeByDefault(options) {
  return { maximumFractionDigits: 0, ...options };
}
