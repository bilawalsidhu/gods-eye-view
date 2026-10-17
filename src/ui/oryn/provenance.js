// Feed status and provenance helpers shared by the layer manager, inspector,
// data-sources page and event queue.
//
// Feed state is derived from what the engine already reports through
// `layerSnapshot` (enabled flag, lifecycle phase, counts, last retrieval,
// error) and is never invented: a feed with no retrieval time is LOADING or
// UNAVAILABLE, not CURRENT.
import { t } from '../../i18n/index.js';
import { layerSnapshot } from '../../data/layerSnapshot.js';

/** ORYN feed states, in the order the UI sorts them. */
export const FEED_STATES = Object.freeze([
  'current',
  'fallback',
  'partial',
  'stale',
  'loading',
  'unavailable',
  'off',
]);

/** Map the engine's feed state onto the ORYN vocabulary. */
export function orynFeedState(engineState) {
  switch (engineState) {
    case 'nominal':
      return 'current';
    case 'fallback':
      return 'fallback';
    case 'loading':
      return 'loading';
    case 'stale':
      return 'stale';
    case 'partial':
    case 'degraded':
      return 'partial';
    case 'unavailable':
      return 'unavailable';
    default:
      return 'off';
  }
}

/**
 * Snapshot one `LayerLifecycle.getAll()` row for ORYN surfaces.
 * @returns {{id:string,name:string,source:string|null,enabled:boolean,state:string,label:string,count:number,lastUpdate:number|null,ageLabel:string|null,error:string|null,requiresKeyId:string|null}}
 */
export function describeFeed(row, { now = Date.now() } = {}) {
  const snapshot = layerSnapshot(row, { now });
  const state = orynFeedState(snapshot.feedState);
  return {
    id: snapshot.id,
    name: snapshot.name,
    source: snapshot.source,
    enabled: snapshot.enabled,
    state,
    label: feedStateLabel(state),
    count: snapshot.count,
    lastUpdate: snapshot.lastUpdate,
    ageLabel: snapshot.ageLabel,
    error: snapshot.error ? String(snapshot.error) : null,
    requiresKeyId: row?.requiresKeyId || null,
    showInTogglePanel: row?.showInTogglePanel !== false,
  };
}

/** Short, accessible text for a feed state; never color-only. */
export function feedStateLabel(state) {
  switch (state) {
    case 'current':
      return t('CURRENT');
    case 'fallback':
      return t('FALLBACK');
    case 'loading':
      return t('LOADING');
    case 'stale':
      return t('STALE');
    case 'partial':
      return t('PARTIAL');
    case 'unavailable':
      return t('UNAVAILABLE');
    default:
      return t('OFF');
  }
}

/** Longer explanation shown in tooltips and the Data Sources page. */
export function feedStateDescription(state) {
  switch (state) {
    case 'current':
      return t('The last refresh succeeded within the expected interval.');
    case 'fallback':
      return t('Served by a fallback source; coverage may differ.');
    case 'loading':
      return t('Waiting for the first successful retrieval.');
    case 'stale':
      return t('The last known good snapshot is older than expected.');
    case 'partial':
      return t(
        'Some records or the last refresh failed; showing what arrived.',
      );
    case 'unavailable':
      return t('No data could be retrieved or the source is not configured.');
    default:
      return t('Layer is turned off.');
  }
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** ISO-like UTC text for any timestamp value; null when unknown. */
export function formatTimestamp(value) {
  const millis = toMillis(value);
  if (millis === null) return null;
  return new Date(millis)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}

/** Human age of a timestamp, e.g. "4 min ago"; null when unknown. */
export function formatAge(value, now = Date.now()) {
  const millis = toMillis(value);
  if (millis === null) return null;
  const seconds = Math.max(0, Math.round((now - millis) / 1000));
  if (seconds < 60) return t('{count}s ago', { count: seconds });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('{count} min ago', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('{count} h ago', { count: hours });
  return t('{count} d ago', { count: Math.round(hours / 24) });
}

/** Label for a provenance kind, used wherever a fact is displayed. */
export function provenanceLabel(kind) {
  switch (kind) {
    case 'measured':
      return t('Measured');
    case 'model':
      return t('Model output');
    case 'analyst':
      return t('Analyst');
    case 'unverified':
      return t('Unverified');
    default:
      return t('Provider-reported');
  }
}
