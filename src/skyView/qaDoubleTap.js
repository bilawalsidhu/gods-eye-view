/**
 * Double-tap retry policy for the synthetic Sky QA harness
 * (scripts/qa-sky-phone.mjs, check K). Pure: no DOM, no browser.
 *
 * Headless software GL can stall the page for longer than the app's 350 ms
 * double-tap window between the two taps of a scripted double tap. Such a
 * pair is two single taps by design (the app must not toggle), so only that
 * case may be retried, and only a bounded number of times. Everything else
 * is a real result and is never retried (review R2):
 *   - not exactly two pointerups (a missing or an extra event): fail;
 *   - timestamps that are not finite or run backwards: fail;
 *   - two pointerups inside the window that did not toggle: fail;
 *   - two pointerups that toggled: pass.
 */

/** The app's double-tap window (skyView.js clear-view double tap). */
export const DOUBLE_TAP_WINDOW_MS = 350;

/**
 * Classify one scripted double tap.
 * @param {{ups: number[], toggled: boolean, windowMs?: number}} attempt
 *   ups: the pointerup timestamps (ms) seen during the attempt, in order.
 * @returns {{verdict: 'toggled'|'retry'|'fail', gap: number|null, reason: string}}
 */
export function doubleTapVerdict({
  ups,
  toggled,
  windowMs = DOUBLE_TAP_WINDOW_MS,
}) {
  const count = Array.isArray(ups) ? ups.length : 0;
  if (count !== 2)
    return {
      verdict: 'fail',
      gap: null,
      reason: `expected 2 pointerups, saw ${count}`,
    };
  const [a, b] = ups;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a)
    return {
      verdict: 'fail',
      gap: null,
      reason: 'pointerup timestamps are not a valid pair',
    };
  const gap = b - a;
  if (toggled) return { verdict: 'toggled', gap, reason: 'double tap toggled' };
  if (gap <= windowMs)
    return {
      verdict: 'fail',
      gap,
      reason: `double tap inside the ${windowMs} ms window did not toggle`,
    };
  return {
    verdict: 'retry',
    gap,
    reason: `taps ${gap} ms apart (over ${windowMs} ms): two single taps`,
  };
}

/**
 * Run a scripted double tap, retrying only the "slow pair" case.
 * @param {(i: number) => Promise<{ups: number[], toggled: boolean}>} attempt
 * @param {{maxTries?: number, windowMs?: number, pause?: (i: number) => Promise<void>}} [opts]
 * @returns {Promise<{ok: boolean, outcome: 'toggled'|'fail'|'exhausted', tries: object[]}>}
 */
export async function doubleTapWithRetry(
  attempt,
  { maxTries = 3, windowMs = DOUBLE_TAP_WINDOW_MS, pause } = {},
) {
  const tries = [];
  for (let i = 0; i < maxTries; i++) {
    const result = await attempt(i);
    const v = doubleTapVerdict({
      ups: result?.ups,
      toggled: Boolean(result?.toggled),
      windowMs,
    });
    tries.push({ ...result, ...v });
    if (v.verdict === 'toggled') return { ok: true, outcome: 'toggled', tries };
    if (v.verdict === 'fail') return { ok: false, outcome: 'fail', tries };
    if (pause && i < maxTries - 1) await pause(i);
  }
  return { ok: false, outcome: 'exhausted', tries };
}
