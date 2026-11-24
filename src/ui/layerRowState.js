import { getLocale, msg, t } from '../i18n/index.js';
import { layerFeedState } from '../data/feedState.js';

// Feed-state values are machine ids (QA hooks, CSS feed-* classes); only the
// label translates.
export const FEED_STATE_LABEL_KEYS = Object.freeze({
  nominal: msg('ON'),
  loading: msg('LOADING'),
  degraded: msg('DEGRADED'),
  stale: msg('STALE'),
  partial: msg('PARTIAL'),
  fallback: msg('FALLBACK'),
  unavailable: msg('UNAVAILABLE'),
});

export function inspectorFeedLabel(tone) {
  if (tone === 'nominal') return t('Live');
  if (tone === 'loading') return t('Loading');
  if (tone === 'stale') return t('Stale');
  const locale = getLocale();
  const label = t(FEED_STATE_LABEL_KEYS[tone]).toLocaleLowerCase(locale);
  return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
}

export const CONTEXT_EXEMPT = Object.freeze(['radio', 'directions']);
export const MISSIONS_LAYER = 'rocket-launches';

export function inspectorLayerRows(rows) {
  return rows.filter((row) => row.enabled && !CONTEXT_EXEMPT.includes(row.id));
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
    updatedAt: Number.isFinite(stats.lastUpdate) ? stats.lastUpdate : null,
  };
}
