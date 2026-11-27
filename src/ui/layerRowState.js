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

/**
 * Why Flights lists no aircraft, when its feed says so: Unavailable, Loading
 * (also before its first update), or Stale or Degraded; '' when the feed is
 * fine and the answer is that none is near.
 */
export function flightsFeedStatus({ readFailed, loading, tone, updatedAt }) {
  if (readFailed || tone === 'unavailable')
    return inspectorFeedLabel('unavailable');
  if (loading || tone === 'loading' || updatedAt === null)
    return inspectorFeedLabel('loading');
  if (tone === 'stale' || tone === 'degraded') return inspectorFeedLabel(tone);
  return '';
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

// At globe view each layer's block splits its count by kind (airliners,
// military, cargo; container ships, tankers), as a bar with its leading kinds
// named under it.
const BAR_SPLITS = ['Type', 'Class', 'Magnitude', 'Mode'];
export function splitBar(found, minimumParts = 2) {
  if (!found?.total) return null;
  const split =
    BAR_SPLITS.map((title) =>
      found.splits.find((one) => one.title === title),
    ).find(Boolean) || found.splits[0];
  if (!split?.parts?.length || split.parts.length < minimumParts) return null;
  const total = split.parts.reduce((sum, part) => sum + part.count, 0);
  return {
    total,
    parts: split.parts.map((part, index) => ({
      label: part.label,
      count: part.count,
      share: part.count / total,
      tone: index,
    })),
  };
}
