import { keySetupRequirement } from '../keySetupCore.mjs';

/**
 * Turn the Street Level layer's UI state into the strings and flags the panel
 * renders. Pure: no DOM, no layer calls, so every wording decision is testable.
 */

const DAY_MS = 86_400_000;

/**
 * Stops of the SINCE slider, oldest window on the left: position 0 shows
 * every capture, the right end only the last month. Stored as relative days
 * so a share link keeps its meaning over time.
 */
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

/** Slider position for a day count: the exact stop, else the nearest one. */
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

/** Readout beside the slider: the window, plus the cut-off date it means today. */
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

/** The header pill doubles as the layer's on/off switch. */
function presentStatus(state) {
  const pressed = state.enabled === true;
  const title = pressed ? 'Turn Street Level off' : 'Turn Street Level on';
  if (state.keyRequired)
    return { text: 'KEY REQUIRED', tone: 'warn', pressed, title };
  if (state.coverage.loading)
    return { text: 'LOADING', tone: 'busy', pressed, title };
  return pressed
    ? { text: 'ON', tone: 'on', pressed, title }
    : { text: 'OFF', tone: '', pressed, title };
}

/**
 * One chip per registered provider; a keyless provider reads as an error
 * chip. A chip is lit only while the layer is on and that provider is
 * switched on, so with a single provider the chip is the layer's switch.
 */
function presentProviders(state) {
  const enabled = state.enabled === true;
  return (state.providers || []).map((provider) => {
    const keyRequired = provider.keyRequired === true;
    const on = enabled && provider.on === true;
    let title = `${provider.name} imagery ${on ? 'on' : 'off'}`;
    if (keyRequired && provider.requiresKeyId)
      title = `${provider.name}: ${keySetupRequirement(provider.requiresKeyId)}`;
    else if (provider.error) title = `${provider.name}: ${provider.error}`;
    return {
      id: provider.id,
      label: provider.label,
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
    captionLeft: street.creator ? `Image by ${street.creator}` : '',
    captionRight: right.join(' · '),
    link: street.externalUrl || null,
    linkLabel: street.providerLabel ? `${street.providerLabel} ↗` : '',
    follow: {
      pressed: street.follow === true,
      disabled: street.open !== true || street.followAvailable !== true,
      title:
        street.followAvailable === true
          ? 'Camera follows view: move the globe camera wherever the street-level view looks'
          : 'Camera follow needs the Google 3D map: choose Google 3D under MAP SOURCE',
    },
  };
}

function presentMeta(state) {
  if (!state.enabled) return 'Switch a provider on to draw its coverage.';
  if (state.sequence.selectedId)
    return state.sequence.loading
      ? 'Loading this sequence…'
      : `${state.sequence.images.toLocaleString()} images in this sequence · Esc clears`;
  if (state.coverage.count > 0)
    return `${state.coverage.count.toLocaleString()} sequences in view · click a line for its photos`;
  return state.coverage.hint || '';
}

/**
 * @param {object} state Snapshot from the layer's `getUIState()`.
 * @param {{now?: number}} [options] Clock for the SINCE readout (tests pin it).
 * @returns {object} Everything the panel needs, already worded.
 */
export function presentStreetLevelPanel(state, { now = Date.now() } = {}) {
  const enabled = state.enabled === true;
  const keyRequired = state.keyRequired === true;
  const filter = state.filter || { pano: 'all', sinceDays: 0 };
  return {
    enabled,
    keyRequired,
    status: presentStatus(state),
    controlsDisabled: keyRequired,
    providers: presentProviders(state),
    error: state.street.error || state.coverage.error || null,
    filter: { pano: filter.pano, sinceDays: Number(filter.sinceDays) || 0 },
    since: presentSince(filter.sinceDays, now),
    legend: state.legend || [],
    viewer: presentViewer(state),
    meta: presentMeta(state),
    /** The panel opens itself when an image opens (a native panel stays put otherwise). */
    wantsOpen: state.street.open === true,
  };
}
