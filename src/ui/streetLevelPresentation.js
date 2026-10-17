import { formatNumber, msg, t, tn, translateKnown } from '../i18n/index.js';
import { keyGuidanceText, keyRequirementText } from './keyGuidance.js';

// Street Level UI state to panel strings and flags. Pure, so it is testable.

const DAY_MS = 86_400_000;

/** SINCE slider stops, in relative days so a share link keeps its meaning. */
export const SINCE_STOPS = Object.freeze([
  Object.freeze({ days: 0, label: msg('ANY DATE') }),
  Object.freeze({ days: 3652, label: msg('LAST 10 YEARS') }),
  Object.freeze({ days: 1826, label: msg('LAST 5 YEARS') }),
  Object.freeze({ days: 1095, label: msg('LAST 3 YEARS') }),
  Object.freeze({ days: 730, label: msg('LAST 2 YEARS') }),
  Object.freeze({ days: 365, label: msg('LAST YEAR') }),
  Object.freeze({ days: 182, label: msg('LAST 6 MONTHS') }),
  Object.freeze({ days: 91, label: msg('LAST 3 MONTHS') }),
  Object.freeze({ days: 30, label: msg('LAST MONTH') }),
]);

/** The exact stop for a day count, else the nearest one. */
export function sinceStopIndex(days) {
  const value = Number(days) || 0;
  if (value <= 0) return 0;
  let best = 1;
  for (let i = 1; i < SINCE_STOPS.length; i++)
    if (
      Math.abs(SINCE_STOPS[i].days - value) <
      Math.abs(SINCE_STOPS[best].days - value)
    )
      best = i;
  return best;
}

function presentSince(days, now) {
  const value = Number(days) || 0;
  const index = sinceStopIndex(value);
  if (value <= 0) return { index, days: 0, label: t('ANY DATE') };
  const stop = SINCE_STOPS[index];
  const window =
    stop.days === value
      ? t(stop.label)
      : tn(value, 'LAST {count} DAY', 'LAST {count} DAYS');
  return {
    index,
    days: value,
    label: t('{window} · SINCE {date}', {
      window,
      date: formatDate(now - value * DAY_MS),
    }),
  };
}

/** YYYY-MM-DD, or YYYY-MM for a provider that dates images by month. */
function formatDate(ms, precision = 'day') {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString().slice(0, precision === 'month' ? 7 : 10);
  } catch {
    return '';
  }
}

/**
 * What the key-gated layer needs: each switched-on provider's key, and the
 * switched-off ones that would draw with a key already set.
 */
function keyGuidance(state) {
  const needs = (state.providers || [])
    .filter((p) => p.on && p.keyRequired && p.requiresKeyId)
    .map((p) => keyRequirementText(p.requiresKeyId))
    .filter(Boolean);
  return keyGuidanceText(
    [...new Set(needs)].join('; '),
    state.keyAlternatives || [],
  );
}

function presentStatus(state) {
  const pressed = state.enabled === true;
  const title = pressed
    ? t('Turn Street Level off')
    : t('Turn Street Level on');
  if (state.keyRejected)
    return { text: t('KEY REJECTED'), tone: 'warn', pressed, title };
  if (state.keyRequired)
    return {
      text: t('KEY REQUIRED'),
      tone: 'warn',
      pressed,
      title: keyGuidance(state) || title,
    };
  if (state.coverage.loading)
    return { text: t('LOADING'), tone: 'busy', pressed, title };
  return pressed
    ? { text: t('ON'), tone: 'on', pressed, title }
    : { text: t('OFF'), tone: '', pressed, title };
}

// Provider refusals with a number stay English data (kartaview and panoramax
// source.js); they go back onto a placeholder here.
const ERROR_PATTERNS = [
  [
    /^KartaView answered HTTP (\d+)$/,
    ([, status]) => t('KartaView answered HTTP {status}', { status }),
  ],
  [
    /^Panoramax answered HTTP (\d+)$/,
    ([, status]) => t('Panoramax answered HTTP {status}', { status }),
  ],
  [
    /^KartaView refused the request \(code (-?\d+)\)$/,
    ([, code]) => t('KartaView refused the request (code {code})', { code }),
  ],
];

/**
 * A provider or viewer error in the UI language. Exported for tests.
 * @param {string} text English error text from a provider.
 * @returns {string}
 */
export function translateStreetLevelError(text) {
  if (typeof text !== 'string' || !text) return text;
  const known = translateKnown(text);
  if (known !== text) return known;
  for (const [pattern, format] of ERROR_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return format(match);
  }
  return text;
}

/** A chip is lit only while the layer and its provider are both on. */
function presentProviders(state) {
  const enabled = state.enabled === true;
  return (state.providers || []).map((provider) => {
    const keyRequired = provider.keyRequired === true;
    const on = enabled && provider.on === true;
    let title = on
      ? t('{name} imagery on', { name: provider.name })
      : t('{name} imagery off', { name: provider.name });
    if (provider.keyRejected && provider.error)
      title = `${provider.name}: ${translateStreetLevelError(provider.error)}`;
    else if (keyRequired && provider.requiresKeyId)
      title = `${provider.name}: ${keyRequirementText(provider.requiresKeyId)}`;
    else if (provider.error)
      title = `${provider.name}: ${translateStreetLevelError(provider.error)}`;
    return {
      id: provider.id,
      label: translateKnown(provider.label),
      color: provider.color || null,
      title,
      active: on,
      disabled: false,
      state: keyRequired
        ? 'error'
        : on && provider.loading
          ? 'loading'
          : on
            ? 'active'
            : 'idle',
      busy: on && provider.loading === true,
    };
  });
}

function presentViewer(state) {
  const { street } = state;
  const right = [];
  if (street.isPano) right.push('360°');
  if (Number.isFinite(street.bearing))
    right.push(`${Math.round(street.bearing)}°`);
  if (street.capturedAt)
    right.push(formatDate(street.capturedAt, street.capturedAtPrecision));
  const left = [];
  if (street.title) left.push(street.title);
  if (street.creator)
    left.push(t('Image by {creator}', { creator: street.creator }));
  if (street.license) left.push(street.license);
  return {
    open: street.open === true,
    loading: street.loading === true && !street.imageId,
    renderMode: street.renderMode === 'fill' ? 'fill' : 'letterbox',
    renderModes: street.renderModes !== false,
    captionLeft: left.join(' · '),
    captionRight: right.join(' · '),
    link: street.externalUrl || null,
    linkLabel: street.providerLabel
      ? `${translateKnown(street.providerLabel)} ↗`
      : '',
    follow: {
      pressed: street.follow === true,
      disabled: street.open !== true || street.followAvailable !== true,
      title:
        street.followAvailable === true
          ? t(
              'Camera follows view: move the globe camera wherever the street-level view looks',
            )
          : t(
              'Camera follow needs the Google 3D map: choose Google 3D under MAP SOURCE',
            ),
    },
  };
}

/** OPEN STREET VIEW: the keyboard path to providers with no coverage to click. */
function presentNearest(state) {
  const targets = (state.providers || []).filter(
    (provider) =>
      provider.on && provider.groundClick && provider.keyRequired !== true,
  );
  if (state.enabled !== true || !targets.length)
    return {
      visible: false,
      label: '',
      title: '',
      disabled: true,
      providerIds: [],
    };
  const names = targets
    .map((provider) => translateKnown(provider.name))
    .join(t(' or '));
  const labels = targets
    .map((provider) => translateKnown(provider.label))
    .join(' / ');
  const ready = state.groundClickReady === true;
  return {
    visible: true,
    label: t('OPEN {labels}', { labels }),
    title: ready
      ? t('Open {names} at the centre of the view', { names })
      : t('Zoom in to a street to open {names} here', { names }),
    disabled: !ready || state.street.loading === true,
    providerIds: targets.map((provider) => provider.id),
  };
}

/** Provider hints are English data joined by " · "; translate each part. */
function translateHint(hint) {
  return hint ? hint.split(' · ').map(translateKnown).join(' · ') : '';
}

function presentMeta(state) {
  if (state.providers.length === 0) return translateHint(state.coverage.hint);
  if (!state.enabled) return t('Switch a provider on to draw its coverage.');
  // Key-gated with another source ready: say how to use it.
  if (state.keyRequired && state.keyAlternatives?.length)
    return keyGuidance(state);
  if (state.sequence.selectedId)
    return state.sequence.loading
      ? t('Loading this sequence…')
      : tn(
          state.sequence.images,
          '{n} image in this sequence · Esc clears',
          '{n} images in this sequence · Esc clears',
          { n: formatNumber(state.sequence.images) },
        );
  const hint = translateHint(state.coverage.hint);
  if (state.coverage.count > 0) {
    const countLine = coverageCountLine(state.coverage);
    return [countLine, hint].filter(Boolean).join(' · ');
  }
  return hint;
}

/**
 * The coverage count line. Providers carry their wording as data
 * (coverageLabel noun/action); each combination needs its own literal tn
 * pair so every language gets real plural forms — the noun cannot inflect
 * through a placeholder in Russian. New wording: add a pair here and to the
 * catalogs (es.json/ru.json).
 * @param {{count: number, label?: {noun?: string, action?: string}|null}} coverage
 */
function coverageCountLine(coverage) {
  const count = coverage.count;
  const values = { n: formatNumber(count) };
  if (coverage.label?.action === 'click a line for its nearest photo')
    return coverage.label.noun === 'streets'
      ? tn(
          count,
          '{n} street in view · click a line for its nearest photo',
          '{n} streets in view · click a line for its nearest photo',
          values,
        )
      : tn(
          count,
          '{n} sequence in view · click a line for its nearest photo',
          '{n} sequences in view · click a line for its nearest photo',
          values,
        );
  return tn(
    count,
    '{n} sequence in view · click a line for its photos',
    '{n} sequences in view · click a line for its photos',
    values,
  );
}

/** @param {{now?: number}} [options] Clock for the SINCE readout. */
export function presentStreetLevelPanel(state, { now = Date.now() } = {}) {
  const enabled = state.enabled === true;
  const keyRequired = state.keyRequired === true;
  const filter = state.filter || { pano: 'all', sinceDays: 0 };
  // A missing key is already shown by the status and chip tooltip; only a
  // rejected key keeps its error line, since that message names the fix.
  const keyMissing = keyRequired && state.keyRejected !== true;
  return {
    enabled,
    keyRequired,
    status: presentStatus(state),
    controlsDisabled: keyRequired || state.providers.length === 0,
    providers: presentProviders(state),
    error: keyMissing
      ? null
      : translateStreetLevelError(
          state.street.error || state.coverage.error || '',
        ) || null,
    filter: { pano: filter.pano, sinceDays: Number(filter.sinceDays) || 0 },
    filterControls: {
      pano: state.filterControls?.pano !== false,
      since: state.filterControls?.since !== false,
    },
    since: presentSince(filter.sinceDays, now),
    sinceNote: state.sinceNote || null,
    legend: state.legend || [],
    viewer: presentViewer(state),
    meta: presentMeta(state),
    nearest: presentNearest(state),
    wantsOpen: state.street.open === true,
  };
}
