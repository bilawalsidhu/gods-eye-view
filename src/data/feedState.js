import { GUIDANCE_STATUSES } from '../loadingFeedback.js';

/**
 * Normalize heterogeneous layer stats into one honest control-chip state.
 * @param {object|null} stats Layer getStats() result.
 * @returns {'nominal'|'loading'|'degraded'|'stale'|'partial'|'fallback'|'unavailable'} Feed state.
 */
export function layerFeedState(stats = {}) {
  const state = stats || {};
  const status =
    typeof state.status === 'string' ? state.status.toLowerCase() : '';
  const source = `${state.source || ''} ${state.coverage || ''}`;
  const hasExplicitFallback = typeof state.fallback === 'boolean';
  const hasPriorData = Number(state.count) > 0 || Boolean(state.lastUpdate);
  const presentedError =
    state.error || state.lastError || state.managerRefreshError;
  if (['unavailable', 'offline', 'down', 'error'].includes(status))
    return 'unavailable';
  if (
    (presentedError ||
      state.unavailable === true ||
      state.available === false) &&
    !hasPriorData &&
    !GUIDANCE_STATUSES.includes(status)
  ) {
    return 'unavailable';
  }
  if (state.loading) return 'loading';
  // Guidance states ask the user to act (zoom in, run a search) — normal
  // operation, not feed faults. One honesty carve-out: layers keep their
  // rendered records through the guidance state, so a genuinely stale cache
  // still reads STALE; a guidance prompt alone never reads DEGRADED.
  if (GUIDANCE_STATUSES.includes(status)) {
    return state.stale ? 'stale' : 'nominal';
  }
  if (
    state.fallback === true ||
    status === 'fallback' ||
    state.mode === 'sim' ||
    /\bfallback\b/i.test(source) ||
    (!hasExplicitFallback && /\badsb\.lol\b/i.test(source))
  ) {
    return 'fallback';
  }
  if (state.stale || status === 'stale') return 'stale';
  if (
    state.degraded ||
    presentedError ||
    state.unavailable === true ||
    state.available === false
  )
    return 'degraded';
  if (state.partial === true) return 'partial';
  return 'nominal';
}
