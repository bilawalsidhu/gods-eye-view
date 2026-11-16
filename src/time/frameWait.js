/**
 * A wait measured in time spent drawing frames, the same at any display
 * refresh rate.
 *
 * Each call to `tick()` adds the time since the previous call, but at most
 * MAX_STEP_MS, so a background tab, a parked scene or a hidden owner (which
 * draw no frames for this wait) does not use the wait up while nothing is on
 * screen.
 */

/** The most one frame may add to a wait, in milliseconds. */
export const MAX_STEP_MS = 100;

/**
 * Start a wait of `limitMs` drawn time.
 * @param {number} limitMs How long to wait, in milliseconds.
 * @param {() => number} [now] Clock in milliseconds.
 * @returns {{tick: () => boolean, pause: () => void}} `tick()` counts one
 *   drawn frame and answers whether the wait is over; `pause()` makes the
 *   next tick count nothing for the gap since the last one.
 */
export function createFrameWait(limitMs, now = () => performance.now()) {
  let waitedMs = 0;
  let lastMs = NaN;
  return {
    tick() {
      const at = now();
      if (Number.isFinite(lastMs))
        waitedMs += Math.min(Math.max(at - lastMs, 0), MAX_STEP_MS);
      lastMs = at;
      return waitedMs >= limitMs;
    },
    pause() {
      lastMs = NaN;
    },
  };
}
