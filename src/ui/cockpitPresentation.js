/** Pure formatting and fixed presentation constants used by Cockpit components. */
import { formatNumber, getLocale, isolate, t, msg } from '../i18n/index.js';
import { formatQuantity } from './unitLabels.js';
import {
  normalizeHeading,
  roundHeadingDegrees,
} from '../data/headingDegrees.js';
import { kilometreDigits } from '../data/distanceFormat.js';

export const COCKPIT_HEADING_SLEW_DPS = 28;

export const COCKPIT_FORWARD_OFFSET_M = 7;

export const COCKPIT_UP_OFFSET_M = 2.6;

export const COCKPIT_MIN_GROUND_CLEARANCE_M = 12;

export const COCKPIT_VIEW_PITCH_DEG = -4;

export const COCKPIT_CAMERA_UPDATE_MS = 50;

export const COCKPIT_HUD_UPDATE_MS = 100;

export const COCKPIT_CONTEXT_UPDATE_MS = 250;

export const COCKPIT_UTILITY_REC_GAP_PX = 12;

export const COCKPIT_UTILITY_SIGNAL_GAP_PX = 8;

export const COCKPIT_UTILITY_MIN_TOP_PX = 96;

export const COCKPIT_UTILITY_MIN_TOP_RATIO = 0.12;

export const COCKPIT_UTILITY_LAUNCHER_MIN_HEIGHT_PX = 50;

export const COCKPIT_GROUND_PROBE_MS = 500;

export const COCKPIT_GROUND_WAIT_TIMEOUT_MS = 5000;

export const COCKPIT_BRIEF_ROTATE_MS = 9000;

export const COCKPIT_REGIONAL_REFRESH_MS = 5 * 60_000;

export const COCKPIT_REGIONAL_REFRESH_DISTANCE_M = 25_000;

export function isRenderedOnScreen(element) {
  if (!element) return false;
  for (let node = element; node instanceof Element; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function formatCockpitBriefAge(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return t('TIME UNKNOWN');
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return t('{count}M AGO', { count: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? t('{count}H AGO', { count: hours })
    : t('{count}D AGO', { count: Math.round(hours / 24) });
}

/** Compass point codes in display order and the label shown for each. */
const COMPASS_POINT_LABELS = Object.freeze({
  N: msg('N'),
  NE: msg('NE'),
  E: msg('E'),
  SE: msg('SE'),
  S: msg('S'),
  SW: msg('SW'),
  W: msg('W'),
  NW: msg('NW'),
});

/**
 * The shown label for a compass point code (`N`, `SW`…): С, ЮЗ… in Russian.
 * Anything else (a degree reading such as `030`) passes through unchanged.
 */
export function compassPointLabel(code) {
  return Object.hasOwn(COMPASS_POINT_LABELS, code)
    ? t(COMPASS_POINT_LABELS[code])
    : code;
}

/** `30.203°N` in the active language: `30,203° с. ш.` in Russian. */
export function formatCockpitCoordinate(value, positive, negative) {
  const amount = formatNumber(Math.abs(value), {
    useGrouping: false,
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
  const code = value >= 0 ? positive : negative;
  // Not «30,203°С»: after a degree sign «С» reads as Celsius. Isolated, so
  // an Arabic hemisphere letter does not pull the next number into its run.
  switch (code) {
    case 'N':
      return isolate(t('{value}°N', { value: amount }));
    case 'S':
      return isolate(t('{value}°S', { value: amount }));
    case 'E':
      return isolate(t('{value}°E', { value: amount }));
    case 'W':
      return isolate(t('{value}°W', { value: amount }));
    default:
      return isolate(`${amount}°${compassPointLabel(code)}`);
  }
}

/**
 * A contact distance such as `4.2 KM` / `44 KM` in the active language
 * (`4,2 КМ`): one decimal under 10 km, whole kilometres beyond.
 */
export function formatCockpitDistance(distanceM) {
  const digits = kilometreDigits(distanceM);
  const distance = formatQuantity(distanceM / 1000, 'km', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return cockpitUnitCase(distance);
}

/**
 * Upper-case a cockpit unit the HUD way (`9.5 KM`), except in Chinese and
 * Japanese, which have no case and keep units as the catalog writes them.
 */
export function cockpitUnitCase(text) {
  return /^(zh|ja)(-|$)/.test(getLocale()) ? text : text.toUpperCase();
}

export function formatCockpitWindDirection(value) {
  if (!Number.isFinite(value)) return t('DIR UNKNOWN');
  const labels = Object.keys(COMPASS_POINT_LABELS);
  const normalized = normalizeHeading(value);
  const degrees = roundHeadingDegrees(value);
  return `${compassPointLabel(labels[Math.round(normalized / 45) % labels.length])} · ${degrees}°`;
}
