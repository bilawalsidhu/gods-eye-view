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
 *   the current time). QA and tests only. Like offset and rate, it changes
 *   now() at once and frameTime() from the next beginFrame (the engine's
 *   next frame); request a render after it in request-render mode.
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
// The wall clock, read through Date.now at each call (so a mocked Date.now
// is the app clock's too).
const wallClock = () => Date.now();

export function createAppClock({ now: source = wallClock } = {}) {
  if (typeof source !== 'function')
    throw new TypeError('createAppClock needs a now() function');
  // Rate 1: wall + offsetMs, exact. Any other rate: anchorValue plus the wall
  // time since anchorSource, scaled. Numbers live in object fields (stored in
  // place), not closure variables, so the per-frame latch allocates nothing.
  const state = {
    offsetMs: 0,
    rate: 1,
    anchorValue: 0,
    anchorSource: 0,
    frozen: false,
    frozenMs: 0,
    latched: false,
    latchedMs: 0,
  };

  const running = () =>
    state.rate === 1
      ? source() + state.offsetMs
      : state.anchorValue + (source() - state.anchorSource) * state.rate;
  const now = () => (state.frozen ? state.frozenMs : running());
  // Make the running clock read `value` from this moment on.
  const runFrom = (value) => {
    if (state.rate === 1) state.offsetMs = value - source();
    else {
      state.anchorValue = value;
      state.anchorSource = source();
    }
  };

  return {
    now,
    frameTime: () => (state.latched ? state.latchedMs : now()),
    beginFrame() {
      state.latchedMs = now();
      state.latched = true;
      return state.latchedMs;
    },
    freeze(ms) {
      state.frozenMs = ms === undefined ? now() : finite(ms, 'Frozen time');
      state.frozen = true;
    },
    resume() {
      if (!state.frozen) return;
      state.frozen = false;
      runFrom(state.frozenMs);
    },
    offset(ms) {
      const value = source() + finite(ms, 'Clock offset');
      state.frozen = false;
      runFrom(value);
    },
    rate(rate) {
      if (!(isFiniteNumber(rate) && rate >= 0))
        throw new TypeError(`Clock rate must be a finite number >= 0: ${rate}`);
      if (state.frozen) {
        state.rate = rate;
        return;
      }
      const value = running();
      state.rate = rate;
      runFrom(value);
    },
    reset() {
      state.offsetMs = 0;
      state.rate = 1;
      state.frozen = false;
    },
    state: () => ({
      frozen: state.frozen,
      offsetMs: now() - source(),
      rate: state.rate,
    }),
  };
}

/** The page's app clock: the one both globe engines and the layers read. */
export const appClock = createAppClock();
