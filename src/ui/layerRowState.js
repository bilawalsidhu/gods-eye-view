import { layerFeedState } from '../data/feedState.js';

export const CONTEXT_EXEMPT = new Set(['radio', 'directions']);
export const MISSIONS_LAYER = 'rocket-launches';

export function inspectorLayerRows(rows) {
  return rows.filter((row) => row.enabled && !CONTEXT_EXEMPT.has(row.id));
}

export function shownApart(id, missionsEnabled) {
  return missionsEnabled && id === MISSIONS_LAYER;
}

export function inspectorHasLayers(rows, missionsEnabled) {
  return (
    missionsEnabled ||
    rows.some((row) => row.enabled && row.id !== 'directions')
  );
}

export function presentLayerRow(row) {
  const stats = row.stats || {};
  // A refresh of a layer holding items keeps its feed state and total.
  const tone = layerFeedState(
    stats.loading && stats.count ? { ...stats, loading: false } : stats,
  );
  return {
    id: row.id,
    tone,
    total:
      Number.isFinite(stats.count) && !(stats.loading && !stats.count)
        ? stats.count
        : null,
    worldTotal:
      stats.scope === 'worldwide' ? (stats.scopeCount ?? stats.count) : null,
    updatedAt: Number.isFinite(stats.lastUpdate) ? stats.lastUpdate : null,
  };
}
