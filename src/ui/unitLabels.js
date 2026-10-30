import { formatNumber, getLocale, msg, t } from '../i18n/index.js';

// Unit ids stay English in data, params and AI-tool readings; only the label
// shown on the page is translated. dBZ and °C read the same in every language.
const UNIT_LABELS = Object.freeze({
  'km/h': msg('km/h'),
  'm/s': msg('m/s'),
  mph: msg('mph'),
  hPa: msg('hPa'),
  kt: msg('kt'),
  kts: msg('kts'),
  ft: msg('ft'),
  km: msg('km'),
  m: msg('m'),
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
  return label ? `${number}${quantitySeparator(label)}${label}` : number;
}

/**
 * A legend stop such as "0.1", "-40" or "300+" in the active language.
 * Anything that is not a plain number is shown as given.
 */
export function formatScaleLabel(label) {
  const match = /^(-?\d+(?:\.\d+)?)(\+?)$/.exec(String(label ?? ''));
  if (!match) return String(label ?? '');
  const decimals = match[1].split('.')[1]?.length || 0;
  return `${formatNumber(Number(match[1]), {
    useGrouping: false,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}${match[2]}`;
}
