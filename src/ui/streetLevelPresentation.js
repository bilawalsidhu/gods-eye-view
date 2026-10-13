import { keySetupRequirement } from '../keySetupCore.mjs';
import { keyStatusLabel } from '../layers/streetLevel/policy.js';

// Street Level UI state to panel strings and flags. Pure, so it is testable.

const DAY_MS = 86_400_000;

/** SINCE slider stops, in relative days so a share link keeps its meaning. */
export const SINCE_STOPS = Object.freeze([
  Object.freeze({ days: 0, label: 'ANY DATE' }),
  Object.freeze({ days: 3652, label: 'LAST 10 YEARS' }),
  Object.freeze({ days: 1826, label: 'LAST 5 YEARS' }),
  Object.freeze({ days: 1095, label: 'LAST 3 YEARS' }),
  Object.freeze({ days: 730, label: 'LAST 2 YEARS' }),
  Object.freeze({ days: 365, label: 'LAST YEAR' }),
  Object.freeze({ days: 182, label: 'LAST 6 MONTHS' }),
  Object.freeze({ days: 91, label: 'LAST 3 MONTHS' }),
  Object.freeze({ days: 30, label: 'LAST MONTH' }),
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
  if (value <= 0) return { index, days: 0, label: 'ANY DATE' };
  const stop = SINCE_STOPS[index];
  const window = stop.days === value ? stop.label : `LAST ${value} DAYS`;
  return {
    index,
    days: value,
    label: `${window} · SINCE ${formatDate(now - value * DAY_MS)}`,
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
  const title = pressed ? 'Turn Street Level off' : 'Turn Street Level on';
  const key = keyStatusLabel(state);
  if (key) return { text: key, tone: 'warn', pressed, title };
  if (state.coverage.loading)
    return { text: 'LOADING', tone: 'busy', pressed, title };
  return pressed
    ? { text: 'ON', tone: 'on', pressed, title }
    : { text: 'OFF', tone: '', pressed, title };
}

/** A chip is lit only while the layer and its provider are both on. */
function presentProviders(state) {
  const enabled = state.enabled === true;
  return (state.providers || []).map((provider) => {
    const keyRequired = provider.keyRequired === true;
    const on = enabled && provider.on === true;
    let title = `${provider.name} imagery ${on ? 'on' : 'off'}`;
    if (provider.keyRejected && provider.error)
      title = `${provider.name}: ${provider.error}`;
    else if (keyRequired && provider.requiresKeyId)
      title = `${provider.name}: ${keySetupRequirement(provider.requiresKeyId)}`;
    else if (provider.error) title = `${provider.name}: ${provider.error}`;
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

/** How to add the key the first switched-on provider is missing. */
function keyHint(state) {
  const provider = (state.providers || []).find(
    (p) => p.on && p.keyRequired && p.requiresKeyId,
  );
  const requirement = provider && keySetupRequirement(provider.requiresKeyId);
  return requirement ? `${provider.name}: ${requirement}` : null;
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
    captionLeft: street.creator ? `Image by ${street.creator}` : '',
    captionRight: right.join(' · '),
    link: street.externalUrl || null,
    linkLabel: street.providerLabel ? `${street.providerLabel} ↗` : '',
  };
}

function presentMeta(state) {
  const providers = state.providers || [];
  if (providers.length === 0) return state.coverage.hint || '';
  if (!state.enabled) return 'Switch Street Level on to draw its coverage.';
  if (!providers.some((p) => p.on))
    return 'Every provider is switched off: light a chip to draw its coverage.';
  if (state.sequence.selectedId)
    return state.sequence.loading
      ? 'Loading this sequence…'
      : `${state.sequence.images.toLocaleString()} images in this sequence · Esc clears`;
  if (state.coverage.count > 0)
    return `${state.coverage.count.toLocaleString()} sequences in view · click a line for its photos`;
  if (state.coverage.hint) return state.coverage.hint;
  // Still loading, or the error line already says why.
  if (state.coverage.loading || state.keyRequired || state.coverage.error)
    return '';
  const filter = state.filter || {};
  return (filter.pano || 'all') !== 'all' || Number(filter.sinceDays) > 0
    ? 'No sequences in view match the filter'
    : 'No coverage in view';
}

/** @param {{now?: number}} [options] Clock for the SINCE readout. */
export function presentStreetLevelPanel(state, { now = Date.now() } = {}) {
  const keyRequired = state.keyRequired === true;
  const filter = state.filter || { pano: 'all', sinceDays: 0 };
  // A missing key says how to add it; a rejected key's own error names the fix.
  const keyMissing = keyRequired && state.keyRejected !== true;
  return {
    enabled: state.enabled === true,
    keyRequired,
    status: presentStatus(state),
    controlsDisabled: keyRequired || (state.providers || []).length === 0,
    providers: presentProviders(state),
    error: keyMissing
      ? keyHint(state)
      : state.street.error ||
        state.sequence.error ||
        state.coverage.error ||
        null,
    filter: { pano: filter.pano, sinceDays: Number(filter.sinceDays) || 0 },
    since: presentSince(filter.sinceDays, now),
    viewer: presentViewer(state),
    meta: presentMeta(state),
  };
}
