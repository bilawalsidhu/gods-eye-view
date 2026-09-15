/**
 * @file Daily upstream-request accounting, shared by the keyed tile proxies.
 *
 * A soft cap per UTC day, persisted as `{date, count}` so it survives a restart,
 * counting fetch *attempts* rather than successes — upstream bills the request
 * either way. Over the cap a proxy serves whatever it already holds rather than
 * dying, which is the house rule: last-good data beats a dead layer.
 *
 * Zero dependencies and Cesium-free so both the vite-plugin providers and their
 * browser-side helpers can import it, and so node:test can exercise it directly.
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
 * Normalize a persisted budget state against today's UTC day key.
 * Rolls the counter to zero on day change; replaces missing/corrupt state.
 * Returns the SAME object when it is already valid for `dayKey` (cheap to
 * call on every request).
 *
 * @param {{date:string, count:number}|null|undefined} state - Persisted state.
 * @param {string} dayKey - Today's UTC day key (from `utcDayKey`).
 * @returns {{date:string, count:number}} Valid state for `dayKey`.
 */
export function normalizeBudget(state, dayKey) {
  const valid =
    Boolean(state) &&
    state.date === dayKey &&
    Number.isFinite(state.count) &&
    state.count >= 0;
  return valid ? state : { date: dayKey, count: 0 };
}

/**
 * Whether the daily soft cap has been reached.
 *
 * @param {{count:number}} state - Normalized budget state.
 * @param {number} limit - Daily tile budget; non-positive/invalid never blocks.
 * @returns {boolean} True when `count >= limit`.
 */
export function isOverBudget(state, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return state.count >= limit;
}
