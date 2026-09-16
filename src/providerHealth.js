import { layerFeedState } from './data/manager.js';

const HEALTH_LABELS = Object.freeze({
  nominal: 'LIVE',
  loading: 'LOADING',
  degraded: 'DEGRADED',
  stale: 'STALE',
  fallback: 'FALLBACK',
  unavailable: 'UNAVAILABLE',
  off: 'OFF',
});

function formatAge(timestamp, now) {
  if (!Number.isFinite(timestamp)) return 'never';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Build a compact, UI-ready health snapshot from DataLayerManager rows. */
export function buildProviderHealthRows(layers, now = Date.now()) {
  return (Array.isArray(layers) ? layers : [])
    .filter((layer) => layer && layer.showInTogglePanel !== false)
    .map((layer) => {
      const state = layer.enabled ? layerFeedState(layer.stats) : 'off';
      const stats = layer.stats || {};
      return {
        id: String(layer.id),
        name: String(layer.name || layer.id),
        source: String(stats.source || layer.source || 'unknown'),
        state,
        label: HEALTH_LABELS[state] || state.toUpperCase(),
        detail: stats.error || stats.lastError || stats.loadingLabel || formatAge(stats.lastUpdate, now),
        updated: formatAge(stats.lastUpdate, now),
        count: Number.isFinite(Number(stats.count)) ? Number(stats.count) : null,
        retryInSec: Number.isFinite(Number(stats.retryInSec)) ? Number(stats.retryInSec) : null,
        keyRequired: stats.keyRequired === true || stats.missingKey === true,
      };
    });
}

export { HEALTH_LABELS };
