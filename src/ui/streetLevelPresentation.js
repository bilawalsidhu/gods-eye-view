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

/** Whether the layer draws: on, and Mapillary not switched off by a link or tool. */
const drawing = (state) => state.enabled === true && state.providerOn !== false;

function presentStatus(state) {
  const pressed = drawing(state);
  const title = pressed ? 'Turn Street Level off' : 'Turn Street Level on';
  const key = keyStatusLabel(state);
  if (key) return { text: key, tone: 'warn', pressed, title };
  if (state.coverage.loading)
    return { text: 'LOADING', tone: 'busy', pressed, title };
  return pressed
    ? { text: 'ON', tone: 'on', pressed, title }
    : { text: 'OFF', tone: '', pressed, title };
}

/** How to add the missing Mapillary key. */
function keyHint() {
  const requirement = keySetupRequirement('mapillary');
  return requirement ? `Mapillary: ${requirement}` : null;
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
    linkLabel: street.externalUrl ? 'MAPILLARY ↗' : '',
  };
}

function presentMeta(state) {
  if (!state.enabled) return 'Switch Street Level on to draw its coverage.';
  if (!drawing(state))
    return 'Mapillary is off in this view. Switch Street Level on to show it.';
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
    : 'No Mapillary coverage in view';
}

/** @param {{now?: number}} [options] Clock for the SINCE readout. */
export function presentStreetLevelPanel(state, { now = Date.now() } = {}) {
  const filter = state.filter || { pano: 'all', sinceDays: 0 };
  // A missing key says how to add it; a rejected key's own error names the fix.
  const keyMissing = state.keyRequired === true && state.keyRejected !== true;
  return {
    enabled: state.enabled === true,
    status: presentStatus(state),
    controlsDisabled: state.keyRequired === true,
    error: keyMissing
      ? keyHint()
      : state.street.error ||
        state.sequence.error ||
        state.coverage.error ||
        null,
    filter: { pano: filter.pano, sinceDays: Number(filter.sinceDays) || 0 },
    since: presentSince(filter.sinceDays, now),
    legend: state.providerOn !== false,
    viewer: presentViewer(state),
    meta: presentMeta(state),
  };
}
