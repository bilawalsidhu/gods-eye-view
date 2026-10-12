import { keySetupRequirement } from '../keySetupCore.mjs';
import { t } from '../i18n/index.js';

// Street Level UI state to panel strings and flags. Pure, so it is testable.
// The `label` fields stay English (stable data); display text resolves
// through `labelKey` at paint so a locale switch re-renders.

const DAY_MS = 86_400_000;

/** SINCE slider stops, in relative days so a share link keeps its meaning. */
export const SINCE_STOPS = Object.freeze([
  Object.freeze({
    days: 0,
    label: 'ANY DATE',
    labelKey: 'streetlevel.since.any',
  }),
  Object.freeze({
    days: 3652,
    label: 'LAST 10 YEARS',
    labelKey: 'streetlevel.since.last10Years',
  }),
  Object.freeze({
    days: 1826,
    label: 'LAST 5 YEARS',
    labelKey: 'streetlevel.since.last5Years',
  }),
  Object.freeze({
    days: 1095,
    label: 'LAST 3 YEARS',
    labelKey: 'streetlevel.since.last3Years',
  }),
  Object.freeze({
    days: 730,
    label: 'LAST 2 YEARS',
    labelKey: 'streetlevel.since.last2Years',
  }),
  Object.freeze({
    days: 365,
    label: 'LAST YEAR',
    labelKey: 'streetlevel.since.lastYear',
  }),
  Object.freeze({
    days: 182,
    label: 'LAST 6 MONTHS',
    labelKey: 'streetlevel.since.last6Months',
  }),
  Object.freeze({
    days: 91,
    label: 'LAST 3 MONTHS',
    labelKey: 'streetlevel.since.last3Months',
  }),
  Object.freeze({
    days: 30,
    label: 'LAST MONTH',
    labelKey: 'streetlevel.since.lastMonth',
  }),
]);

/** The display label for a SINCE stop index, in the active locale. */
export function sinceStopLabel(index) {
  const stop = SINCE_STOPS[index];
  return stop ? t(stop.labelKey) : '';
}

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
  if (value <= 0) return { index, days: 0, label: t('streetlevel.since.any') };
  const stop = SINCE_STOPS[index];
  const window =
    stop.days === value
      ? t(stop.labelKey)
      : t('streetlevel.since.lastDays', { n: value });
  return {
    index,
    days: value,
    label: t('streetlevel.since.readout', {
      window,
      date: formatDate(now - value * DAY_MS),
    }),
  };
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

function presentStatus(state) {
  const pressed = state.enabled === true;
  const title = t(
    pressed ? 'streetlevel.status.titleOn' : 'streetlevel.status.titleOff',
  );
  if (state.keyRejected)
    return {
      text: t('streetlevel.status.keyRejected'),
      tone: 'warn',
      pressed,
      title,
    };
  if (state.keyRequired)
    return {
      text: t('streetlevel.status.keyRequired'),
      tone: 'warn',
      pressed,
      title,
    };
  if (state.coverage.loading)
    return {
      text: t('streetlevel.status.loading'),
      tone: 'busy',
      pressed,
      title,
    };
  return pressed
    ? { text: t('streetlevel.status.on'), tone: 'on', pressed, title }
    : { text: t('streetlevel.status.off'), tone: '', pressed, title };
}

/** A chip is lit only while the layer and its provider are both on. */
function presentProviders(state) {
  const enabled = state.enabled === true;
  return (state.providers || []).map((provider) => {
    const keyRequired = provider.keyRequired === true;
    const on = enabled && provider.on === true;
    let title = t(on ? 'streetlevel.chip.on' : 'streetlevel.chip.off', {
      name: provider.name,
    });
    if (provider.keyRejected && provider.error)
      title = t('streetlevel.chip.error', {
        name: provider.name,
        error: provider.error,
      });
    else if (keyRequired && provider.requiresKeyId)
      title = t('streetlevel.chip.error', {
        name: provider.name,
        error: keySetupRequirement(provider.requiresKeyId),
      });
    else if (provider.error)
      title = t('streetlevel.chip.error', {
        name: provider.name,
        error: provider.error,
      });
    return {
      id: provider.id,
      label: provider.label,
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
  if (street.capturedAt) right.push(formatDate(street.capturedAt));
  return {
    open: street.open === true,
    loading: street.loading === true && !street.imageId,
    renderMode: street.renderMode === 'fill' ? 'fill' : 'letterbox',
    captionLeft: street.creator
      ? t('streetlevel.viewer.imageBy', { name: street.creator })
      : '',
    captionRight: right.join(' · '),
    link: street.externalUrl || null,
    linkLabel: street.providerLabel ? `${street.providerLabel} ↗` : '',
    follow: {
      pressed: street.follow === true,
      disabled: street.open !== true || street.followAvailable !== true,
      title:
        street.followAvailable === true
          ? t('streetlevel.viewer.followTooltip')
          : t('streetlevel.viewer.followNeedsGoogle'),
    },
  };
}

function presentMeta(state) {
  if (state.providers.length === 0) return state.coverage.hint || '';
  if (!state.enabled) return t('streetlevel.meta.off');
  if (state.sequence.selectedId)
    return state.sequence.loading
      ? t('streetlevel.meta.sequenceLoading')
      : t('streetlevel.meta.sequence', {
          n: state.sequence.images.toLocaleString(),
        });
  if (state.coverage.count > 0)
    return t('streetlevel.meta.coverage', {
      n: state.coverage.count.toLocaleString(),
    });
  return state.coverage.hint || '';
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
      : state.street.error || state.coverage.error || null,
    filter: { pano: filter.pano, sinceDays: Number(filter.sinceDays) || 0 },
    since: presentSince(filter.sinceDays, now),
    legend: (state.legend || []).map((entry) =>
      entry.label === 'Selected'
        ? { ...entry, label: t('streetlevel.legend.selected') }
        : entry,
    ),
    viewer: presentViewer(state),
    meta: presentMeta(state),
    wantsOpen: state.street.open === true,
  };
}
