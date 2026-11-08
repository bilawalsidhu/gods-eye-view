/**
 * The scenario clock: play, pause, rate and seek over a fixed duration, driven
 * by wall time so it does not depend on frame rate. Pure; the layer reads it
 * once per frame.
 * @module layers/simulation/clock
 */

export const RATE_OPTIONS = Object.freeze([0.5, 1, 2, 4]);
export const MIN_RATE = 0.1;
export const MAX_RATE = 16;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now] Wall clock, milliseconds.
 * @param {number} [options.durationS] Scenario length; 0 means unbounded.
 * @param {boolean} [options.loop] Wrap at the end instead of stopping there.
 */
export function createSimulationClock({
  now = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now(),
  durationS = 0,
  loop = true,
} = {}) {
  let duration = Math.max(0, Number(durationS) || 0);
  let wrap = loop !== false;
  let rate = 1;
  let playing = false;
  let anchorWall = now();
  let anchorTime = 0;

  function raw() {
    return anchorTime + (playing ? ((now() - anchorWall) / 1000) * rate : 0);
  }

  function bound(t) {
    if (!(duration > 0)) return Math.max(0, t);
    if (wrap) return ((t % duration) + duration) % duration;
    return clamp(t, 0, duration);
  }

  function reanchor() {
    anchorTime = bound(raw());
    anchorWall = now();
  }

  return {
    /** Scenario seconds now. */
    timeS() {
      return bound(raw());
    },
    get playing() {
      return playing;
    },
    get rate() {
      return rate;
    },
    get durationS() {
      return duration;
    },
    get loop() {
      return wrap;
    },
    /** A finite scenario that reached its end while playing. */
    ended() {
      return !wrap && duration > 0 && playing && raw() >= duration;
    },
    play() {
      if (playing) return;
      reanchor();
      playing = true;
      anchorWall = now();
    },
    pause() {
      if (!playing) return;
      reanchor();
      playing = false;
    },
    setRate(next) {
      const value = Number(next);
      if (!Number.isFinite(value)) return;
      reanchor();
      rate = clamp(value, MIN_RATE, MAX_RATE);
    },
    seek(tS) {
      const value = Number(tS);
      if (!Number.isFinite(value)) return;
      anchorTime = bound(value);
      anchorWall = now();
    },
    setDuration(nextDurationS, nextLoop = wrap) {
      reanchor();
      duration = Math.max(0, Number(nextDurationS) || 0);
      wrap = nextLoop !== false;
      anchorTime = bound(anchorTime);
    },
    snapshot() {
      return {
        timeS: bound(raw()),
        playing,
        rate,
        durationS: duration,
        loop: wrap,
      };
    },
  };
}
