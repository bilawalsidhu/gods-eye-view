/**
 * Arming/settle policy for the global loading chip's self-stopping 60 ms
 * ticker (Batch G carve-out — docs/PLAN.md).
 *
 * The chip's reducer (src/loadingFeedback.js) is TIME-driven: reveal delay,
 * long-load threshold, and terminal dwell all advance only on real ticks.
 * StyleManager owns the interval itself (plus the visibilitychange re-arm);
 * everything here is the deterministic decision math it consults, extracted
 * so the arm/stop conditions are unit-testable without DOM or timers.
 */

/**
 * Whether the loading chip needs a ticker right now.
 * @param {string|undefined} phase Loading-feedback phase
 *   (undefined/'idle' when settled).
 * @param {object|null} notice Active global status notice, if any.
 * @returns {boolean} True while loading is active or a timed notice is up.
 */
export function loadingTickerNeeded(phase, notice) {
  if (phase !== 'idle') return true;
  return Number.isFinite(notice?.hideAt);
}

/**
 * Whether the loading chip has fully settled and the ticker can stop.
 * Symmetric with {@link loadingTickerNeeded} — never both true for the same
 * inputs.
 * @param {string|undefined} phase Loading-feedback phase.
 * @param {object|null} notice Active global status notice, if any.
 * @returns {boolean} True when the ticker should stop.
 */
export function loadingTickerSettled(phase, notice) {
  return !loadingTickerNeeded(phase, notice);
}

/**
 * Whether a finite global status notice has outlived its dwell and should
 * be cleared. Persistent notices never expire here.
 * @param {object|null} notice Active notice ({ persistent?, hideAt? }).
 * @param {number} now Current performance.now().
 * @returns {boolean} True when the notice should be dropped.
 */
export function globalStatusNoticeExpired(notice, now) {
  if (!notice || notice.persistent === true) return false;
  if (!Number.isFinite(notice.hideAt)) return false;
  return now >= notice.hideAt;
}
