/**
 * Backoff progression for the unavailable-state retry: 30 s, doubling to a
 * 240 s ceiling. Pure so the progression is pinnable without booting a layer.
 */
export function unavailableRetryDelayMs(prevDelayMs) {
  const RETRY_MIN_MS = 30000;
  const RETRY_CEIL_MS = 240000;
  if (!Number.isFinite(prevDelayMs) || prevDelayMs <= 0) return RETRY_MIN_MS;
  return Math.min(prevDelayMs * 2, RETRY_CEIL_MS);
}

/**
 * Fetches normally run on enable and moveEnd. While the layer is enabled and
 * unavailable, retry on a 30 s → 240 s backoff. Success, a user-driven load,
 * zoom-out or disable cancels it.
 *
 * Reads and writes `state.enabled`, `state.loading`, `state.retryTimer`,
 * `state.retryDelayMs` and `state.retryAt`.
 * @param {object} state Layer state.
 * @param {() => void} load Starts the layer's load.
 */
export function createUnavailableRetry(state, load) {
  return {
    /** @param {number} [retryAfterMs] Server-requested floor for the delay. */
    schedule(retryAfterMs = 0) {
      if (!state.enabled) return;
      clearTimeout(state.retryTimer);
      state.retryDelayMs = Math.max(
        retryAfterMs,
        unavailableRetryDelayMs(state.retryDelayMs),
      );
      state.retryAt = Date.now() + state.retryDelayMs;
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        state.retryAt = 0;
        if (state.enabled && !state.loading) load();
      }, state.retryDelayMs);
    },
    clear({ resetBackoff = true } = {}) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
      state.retryAt = 0;
      if (resetBackoff) state.retryDelayMs = 0;
    },
  };
}
