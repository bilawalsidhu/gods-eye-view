/**
 * @file Upstream-request accounting shared by the keyed tile proxies.
 *
 * A soft cap per UTC period, persisted as `{date, count}` so it survives a
 * restart. Nothing here is provider-specific: the caller picks the period by
 * the key it passes, and decides what happens over the cap.
 *
 * Zero dependencies and Cesium-free, so providers and browser helpers can
 * import it and node:test can exercise it directly.
 *
 * @module data/tileBudget
 */

/**
 * UTC calendar-day key for budget bucketing.
 *
 * @param {number} [epochMs=Date.now()] - Timestamp in ms.
 * @returns {string} 'YYYY-MM-DD' in UTC.
 */
export function utcDayKey(epochMs = Date.now()) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Normalize a persisted budget state against the current period key.
 * Rolls the counter to zero when the period changes; replaces missing/corrupt
 * state. Returns the SAME object when it is already valid for `periodKey`
 * (cheap to call on every request).
 *
 * @param {{date:string, count:number}|null|undefined} state - Persisted state.
 * @param {string} periodKey - Current period key, e.g. from `utcDayKey`.
 * @returns {{date:string, count:number}} Valid state for `periodKey`.
 */
export function normalizeBudget(state, periodKey) {
  const valid =
    Boolean(state) &&
    state.date === periodKey &&
    Number.isFinite(state.count) &&
    state.count >= 0;
  return valid ? state : { date: periodKey, count: 0 };
}

/**
 * Whether the soft cap for the current period has been reached.
 *
 * @param {{count:number}} state - Normalized budget state.
 * @param {number} limit - Budget per period; non-positive/invalid never blocks.
 * @returns {boolean} True when `count >= limit`.
 */
export function isOverBudget(state, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return state.count >= limit;
}
