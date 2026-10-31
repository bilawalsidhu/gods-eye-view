/** Pure formatting and fixed presentation constants used by Cockpit components. */
import { formatNumber, getLocale, t, msg } from '../i18n/index.js';
import { formatQuantity } from './unitLabels.js';

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

export const COCKPIT_BRIEF_CYCLE_OFF_HELP =
  'Cycle briefing pages automatically every 9 seconds (Signals → News → Local). Pauses while you hover or focus the panel. Live signal data refreshes continuously either way.';

export const COCKPIT_BRIEF_CYCLE_ON_HELP =
  'Stop automatic page cycling. Previous, Next, and the SIG/NEWS/LOCAL tabs stay available.';

export const COCKPIT_REGIONAL_REFRESH_MS = 5 * 60_000;

export const COCKPIT_REGIONAL_REFRESH_DISTANCE_M = 25_000;

export const COCKPIT_BRIEF_PAGES = [
  {
    id: 'signals',
    kickerKey: msg('LIVE SIGNALS'),
    subtitleKey: msg('OBSERVED / MAPPED PINGS'),
    sourceKey: msg('SOURCE-BACKED EVENTS · NO SYNTHETIC NEWS'),
  },
  {
    id: 'news',
    kickerKey: msg('REGIONAL NEWS'),
    subtitleKey: msg('LATEST LOCATION-MATCHED REPORTING'),
    sourceKey: msg('{source} · LOCATION QUERY · RECENT'),
    sourceName: 'GOOGLE NEWS RSS', // i18n-ignore: provider name
  },
  {
    id: 'local',
    kickerKey: msg('LOCAL INFO'),
    subtitleKey: msg('PLACE / CONDITIONS / POSITION'),
    // Attribution stays English.
    source: 'NATURAL EARTH · OPEN-METEO · UTC',
  },
];

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
  // Not «30,203°С»: after a degree sign «С» reads as Celsius.
  switch (code) {
    case 'N':
      return t('{value}°N', { value: amount });
    case 'S':
      return t('{value}°S', { value: amount });
    case 'E':
      return t('{value}°E', { value: amount });
    case 'W':
      return t('{value}°W', { value: amount });
    default:
      return `${amount}°${compassPointLabel(code)}`;
  }
}

/**
 * A contact distance such as `4.2 KM` / `44 KM` in the active language
 * (`4,2 КМ`): one decimal under 10 km, whole kilometres beyond.
 */
export function formatCockpitDistance(distanceM) {
  const digits = distanceM < 10000 ? 1 : 0;
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
  const normalized = ((value % 360) + 360) % 360;
  // 359.5° and above is north. Modulo keeps that from printing 360°.
  const degrees = Math.round(normalized) % 360;
  return `${compassPointLabel(labels[Math.round(normalized / 45) % labels.length])} · ${degrees}°`;
}

// Digit grouping and decimal marks (`26,175`, `26 175`, `26.175`) take a
// narrow cell; a full digit cell would open a gap in the middle of a number.
const ROLL_SEPARATOR = /^[,.\u00a0\u202f]$/;

function rollTokenClass(character) {
  return ROLL_SEPARATOR.test(character)
    ? 'cockpit-roll-token is-separator'
    : 'cockpit-roll-token';
}

export function setCockpitRollingValue(
  element,
  text,
  numericValue,
  { circularRange = null, immediate = false } = {},
) {
  if (!element) return;
  const nextText = String(text);
  const previousText = element.dataset.rollingText;
  const previousValue = Number(element.dataset.rollingValue);
  const nowMs = performance.now();
  const lastRollMs = Number(element.dataset.rollingAt);
  if (
    !immediate &&
    previousText !== undefined &&
    previousText !== nextText &&
    Number.isFinite(lastRollMs) &&
    nowMs - lastRollMs < 220
  ) {
    return;
  }
  element.dataset.rollingText = nextText;
  element.dataset.rollingAt = String(nowMs);
  if (Number.isFinite(numericValue))
    element.dataset.rollingValue = String(numericValue);
  else delete element.dataset.rollingValue;
  element.setAttribute('aria-label', nextText);

  if (immediate || previousText === undefined || previousText === nextText) {
    if (
      previousText !== nextText ||
      !element.querySelector('.cockpit-roll-token')
    ) {
      element.replaceChildren(
        ...Array.from(nextText, (character) => {
          const token = document.createElement('span');
          token.className = rollTokenClass(character);
          token.setAttribute('aria-hidden', 'true');
          token.textContent = character;
          return token;
        }),
      );
    }
    return;
  }

  let delta =
    Number.isFinite(numericValue) && Number.isFinite(previousValue)
      ? numericValue - previousValue
      : 0;
  if (Number.isFinite(circularRange) && circularRange > 0) {
    const halfRange = circularRange / 2;
    if (delta > halfRange) delta -= circularRange;
    else if (delta < -halfRange) delta += circularRange;
  }
  const direction = delta < 0 ? 'down' : 'up';
  const width = Math.max(previousText.length, nextText.length);
  const from = previousText.padStart(width, ' ');
  const to = nextText.padStart(width, ' ');
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < width; index += 1) {
    const previousCharacter = from[index];
    const nextCharacter = to[index];
    const token = document.createElement('span');
    token.className = rollTokenClass(nextCharacter);
    token.setAttribute('aria-hidden', 'true');

    if (
      previousCharacter === nextCharacter ||
      !/\d/.test(previousCharacter) ||
      !/\d/.test(nextCharacter)
    ) {
      token.textContent = nextCharacter === ' ' ? '\u00a0' : nextCharacter;
      fragment.append(token);
      continue;
    }

    token.classList.add('is-rolling', `roll-${direction}`);
    const track = document.createElement('span');
    track.className = 'cockpit-roll-track';
    const first = document.createElement('span');
    const second = document.createElement('span');
    first.textContent = direction === 'up' ? previousCharacter : nextCharacter;
    second.textContent = direction === 'up' ? nextCharacter : previousCharacter;
    track.append(first, second);
    token.append(track);
    fragment.append(token);
  }

  element.replaceChildren(fragment);
}
