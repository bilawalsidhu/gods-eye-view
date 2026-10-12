/** Pure formatting and fixed presentation constants used by Cockpit components. */
import { t } from '../i18n/index.js';

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

// Locale-independent MESSAGE KEYS, resolved through t() at paint time (rule:
// never build translated label maps at module top level — that would freeze
// English). cockpitBriefing.js resolves them inside its render paths.
export const COCKPIT_BRIEF_CYCLE_OFF_HELP_KEY = 'cockpit.brief.cycleOffHelp';

export const COCKPIT_BRIEF_CYCLE_ON_HELP_KEY = 'cockpit.brief.cycleOnHelp';

export const COCKPIT_REGIONAL_REFRESH_MS = 5 * 60_000;

export const COCKPIT_REGIONAL_REFRESH_DISTANCE_M = 25_000;

// Kicker/subtitle/source are KEYS here; showBriefPage() resolves them through
// t() on every page paint so a locale switch repaints on the next render.
export const COCKPIT_BRIEF_PAGES = [
  {
    id: 'signals',
    kickerKey: 'cockpit.brief.pages.signals.kicker',
    subtitleKey: 'cockpit.brief.pages.signals.subtitle',
    sourceKey: 'cockpit.brief.pages.signals.source',
  },
  {
    id: 'news',
    kickerKey: 'cockpit.brief.pages.news.kicker',
    subtitleKey: 'cockpit.brief.pages.news.subtitle',
    sourceKey: 'cockpit.brief.pages.news.source',
  },
  {
    id: 'local',
    kickerKey: 'cockpit.brief.pages.local.kicker',
    subtitleKey: 'cockpit.brief.pages.local.subtitle',
    sourceKey: 'cockpit.brief.pages.local.source',
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
  if (!Number.isFinite(timestamp)) return t('cockpit.brief.age.unknown');
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return t('cockpit.brief.age.minutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? t('cockpit.brief.age.hours', { n: hours })
    : t('cockpit.brief.age.days', { n: Math.round(hours / 24) });
}

export function formatCockpitWindDirection(value) {
  if (!Number.isFinite(value)) return t('cockpit.brief.windDirectionUnknown');
  // Compass points are international abbreviations and stay verbatim.
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const normalized = ((value % 360) + 360) % 360;
  return `${labels[Math.round(normalized / 45) % labels.length]} · ${Math.round(normalized)}°`;
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
          token.className = 'cockpit-roll-token';
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
    token.className = 'cockpit-roll-token';
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
