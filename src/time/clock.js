// The app's own time: milliseconds since the Unix epoch, read by layers and
// both globe engines instead of Cesium's JulianDate or viewer.clock. By
// default it is the wall clock (Date.now) exactly; QA and tests can freeze,
// offset or speed it up. The globe engine latches one frame time per engine
// frame (beginFrame), so every reader in a frame sees the same value.
// No engine, DOM or Node imports: this runs in the browser and in Node tests.

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value);

function finite(value, label) {
  if (!isFiniteNumber(value))
    throw new TypeError(`${label} must be a finite number: ${value}`);
  return value;
}

/**
 * @typedef {object} AppClock
 * @property {() => number} now The current app time (ms since the epoch).
 * @property {() => number} frameTime The time latched for the current engine
 *   frame; the current time before the first frame.
 * @property {() => number} beginFrame Latches and returns the frame time; the
 *   globe engine calls it once at the start of each of its frames.
 * @property {(ms?: number) => void} freeze Holds the time at `ms` (default:
 *   the current time). QA and tests only.
 * @property {() => void} resume Runs on from the frozen time.
 * @property {(ms: number) => void} offset Sets the time to the wall clock
 *   plus `ms`, running on from it at the current rate (it ends a freeze).
 *   QA and tests only.
 * @property {(rate: number) => void} rate App milliseconds per wall
 *   millisecond (>= 0), without a jump. QA and tests only.
 * @property {() => void} reset Back to the wall clock.
 * @property {() => { frozen: boolean, offsetMs: number, rate: number }} state
 *   The controls in force (offsetMs: the current time minus the wall clock).
 */

/**
 * @param {{ now?: () => number }} [options] `now`: the wall clock (Date.now).
 * @returns {AppClock}
 */
export function createAppClock({ now: source = () => Date.now() } = {}) {
  if (typeof source !== 'function')
    throw new TypeError('createAppClock needs a now() function');
  // Rate 1: wall + offsetMs, exact. Any other rate: anchorValue plus the wall
  // time since anchorSource, scaled.
  let offsetMs = 0;
  let rateValue = 1;
  let anchorValue = 0;
  let anchorSource = 0;
  let frozen = null;
  let latched = null;

  const running = () =>
    rateValue === 1
      ? source() + offsetMs
      : anchorValue + (source() - anchorSource) * rateValue;
  const now = () => (frozen === null ? running() : frozen);
  // Make the running clock read `value` from this moment on.
  const runFrom = (value) => {
    if (rateValue === 1) offsetMs = value - source();
    else {
      anchorValue = value;
      anchorSource = source();
    }
  };

  return {
    now,
    frameTime: () => (latched === null ? now() : latched),
    beginFrame() {
      latched = now();
      return latched;
    },
    freeze(ms) {
      frozen = ms === undefined ? now() : finite(ms, 'Frozen time');
    },
    resume() {
      if (frozen === null) return;
      const value = frozen;
      frozen = null;
      runFrom(value);
    },
    offset(ms) {
      const value = source() + finite(ms, 'Clock offset');
      frozen = null;
      runFrom(value);
    },
    rate(rate) {
      if (!(isFiniteNumber(rate) && rate >= 0))
        throw new TypeError(`Clock rate must be a finite number >= 0: ${rate}`);
      if (frozen !== null) {
        rateValue = rate;
        return;
      }
      const value = running();
      rateValue = rate;
      runFrom(value);
    },
    reset() {
      offsetMs = 0;
      rateValue = 1;
      frozen = null;
    },
    state: () => ({
      frozen: frozen !== null,
      offsetMs: now() - source(),
      rate: rateValue,
    }),
  };
}

/** The page's app clock: the one both globe engines and the layers read. */
export const appClock = createAppClock();
