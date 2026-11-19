/**
 * @module replay/clock
 * @description Replay's own playback clock, run on the renderer's frame port.
 * It keeps a time inside the replay window, moves it at `speed` times real
 * time while playing, and sets the scene's time to it each frame so the sun
 * and sky follow the slider. The scene's own time is put back on stop.
 * While playing it holds the frame loop continuous; paused, a seek asks for
 * one frame.
 */
import { frameOf } from '../render/rendererOf.js';

/** The longest step one frame may take, seconds, so a stalled tab does not leap. */
const MAX_STEP_S = 0.25;

/**
 * @param {{viewer: object, onTick?: (ms: number) => void}} options
 *   `onTick` runs each frame the replay is on (and after a seek).
 */
export function createReplayClock({ viewer, onTick }) {
  const frame = frameOf(viewer);
  let on = false;
  let playing = false;
  let ms = 0;
  let startMs = 0;
  let stopMs = 0;
  let speed = 1;
  let saved = null;
  let release = null;
  let off = null;

  const hold = (want) => {
    if (want && !release) release = frame.holdContinuous('replay');
    if (!want && release) {
      release();
      release = null;
    }
  };

  const apply = () => {
    frame.setTime(ms);
    onTick?.(ms);
  };

  const step = ({ dt }) => {
    if (!on || !playing) return;
    ms = Math.min(stopMs, ms + Math.min(dt, MAX_STEP_S) * 1000 * speed);
    if (ms >= stopMs) {
      playing = false;
      hold(false);
    }
    apply();
  };

  return {
    get active() {
      return on;
    },
    get playing() {
      return on && playing;
    },
    get ms() {
      return ms;
    },
    /** Begin replaying `[startMs, endMs]` from its start, paused. */
    start(from, endMs, rate) {
      if (!on) {
        saved = frame.time();
        off = frame.on('preUpdate', step);
      }
      on = true;
      playing = false;
      hold(false);
      startMs = from;
      ms = from;
      stopMs = endMs;
      speed = rate;
      apply();
    },
    /** Put the scene's time back and let go of the frame loop. */
    stop() {
      if (!on) return;
      on = false;
      playing = false;
      hold(false);
      off?.();
      off = null;
      if (saved != null) frame.setTime(saved);
      saved = null;
    },
    seek(to) {
      if (!on) return;
      ms = Math.max(startMs, Math.min(stopMs, to));
      apply();
    },
    setSpeed(rate) {
      speed = rate;
    },
    toggle() {
      if (!on) return;
      if (!playing && ms >= stopMs) ms = startMs;
      playing = !playing;
      hold(playing);
      if (playing) frame.requestRender('replay');
    },
  };
}
