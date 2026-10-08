import { keySetupRequirement } from '../keySetupCore.mjs';

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

/** YYYY-MM-DD, or YYYY-MM for a provider that dates images by month. */
function formatDate(ms, precision = 'day') {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString().slice(0, precision === 'month' ? 7 : 10);
  } catch {
    return '';
  }
}

function presentStatus(state) {
  const pressed = state.enabled === true;
  const title = pressed ? 'Turn Street Level off' : 'Turn Street Level on';
  if (state.keyRejected)
    return { text: 'KEY REJECTED', tone: 'warn', pressed, title };
  if (state.keyRequired)
    return { text: 'KEY REQUIRED', tone: 'warn', pressed, title };
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
  if (street.creator) left.push(`Image by ${street.creator}`);
  return {
    open: street.open === true,
    loading: street.loading === true && !street.imageId,
    renderMode: street.renderMode === 'fill' ? 'fill' : 'letterbox',
    renderModes: street.renderModes !== false,
    captionLeft: left.join(' · '),
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

/**
 * A button for the providers with no coverage to click (Street View): opens
 * their nearest image at the view centre, so they need no pointer.
 */
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
  const names = targets.map((provider) => provider.name).join(' or ');
  const ready = state.groundClickReady === true;
  return {
    visible: true,
    label: `OPEN ${targets.map((provider) => provider.label).join(' / ')}`,
    title: ready
      ? `Open ${names} at the centre of the view`
      : `Zoom in to a street to open ${names} here`,
    disabled: !ready || state.street.loading === true,
    providerIds: targets.map((provider) => provider.id),
  };
}

function presentMeta(state) {
  if (!state.enabled) return 'Switch a provider on to draw its coverage.';
  if (state.sequence.selectedId)
    return state.sequence.loading
      ? 'Loading this sequence…'
      : `${state.sequence.images.toLocaleString()} images in this sequence · Esc clears`;
  const hint = state.coverage.hint || '';
  if (state.coverage.count > 0)
    return [
      `${state.coverage.count.toLocaleString()} sequences in view · click a line for its photos`,
      hint,
    ]
      .filter(Boolean)
      .join(' · ');
  return hint;
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
    controlsDisabled: keyRequired,
    providers: presentProviders(state),
    error: keyMissing
      ? null
      : state.street.error || state.coverage.error || null,
    filter: { pano: filter.pano, sinceDays: Number(filter.sinceDays) || 0 },
    since: presentSince(filter.sinceDays, now),
    legend: state.legend || [],
    viewer: presentViewer(state),
    meta: presentMeta(state),
    nearest: presentNearest(state),
    wantsOpen: state.street.open === true,
  };
}
