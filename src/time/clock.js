// The app's own time: milliseconds since the Unix epoch, read by layers and
// both globe engines instead of Cesium's JulianDate or viewer.clock. By
// default it is the wall clock (Date.now) exactly; QA and tests can freeze
// it. The globe engine latches one frame time per engine frame
// (beginFrame), so every reader in a frame sees the same value.
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
 *   the current time). QA and tests only. It changes now() at once and
 *   frameTime() from the next beginFrame (the engine's next frame); request
 *   a render after it in request-render mode.
 * @property {() => void} resume Runs on from the frozen time.
 * @property {() => void} reset Back to the wall clock.
 * @property {() => { frozen: boolean, offsetMs: number }} state
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
  // Running: wall + offsetMs, exact. Numbers live in object fields (stored
  // in place), not closure variables, so the per-frame latch allocates
  // nothing.
  const state = {
    offsetMs: 0,
    frozen: false,
    frozenMs: 0,
    latched: false,
    latchedMs: 0,
  };

  const now = () => (state.frozen ? state.frozenMs : source() + state.offsetMs);

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
      // Run on from the frozen time.
      state.offsetMs = state.frozenMs - source();
    },
    reset() {
      state.offsetMs = 0;
      state.frozen = false;
    },
    state: () => ({
      frozen: state.frozen,
      offsetMs: now() - source(),
    }),
  };
}

/** The page's app clock: the one both globe engines and the layers read. */
export const appClock = createAppClock();
