import { DAY_DURATION_MS, SEEK_DURATION_MS } from './policy.js';

/** Browser animation clock; tests inject their own. */
const BROWSER_ANIMATION = Object.freeze({
  request: (callback) => globalThis.requestAnimationFrame(callback),
  cancel: (id) => globalThis.cancelAnimationFrame(id),
});

/** @param {number} t Unit interval. @returns {number} Ease-in-out. */
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Pause on the last day before looping, so the forecast is read, not flashed. */
const END_HOLD_DAYS = 0.75;

/**
 * Continuous playback over the window's days.
 *
 * The playhead advances every animation frame; the renderer blends region
 * ratings and runs avalanches down their paths from it, so the ten days play
 * as one motion rather than ten cuts. A clicked day glides there and pauses.
 */
export function createPlayback({ state: layerState, services, parts }) {
  const animation = services.animation ?? BROWSER_ANIMATION;
  let frameId = null;
  let lastTime = null;
  /** Active glide: `{from, to, start}`, or null. */
  let seek = null;

  const dayCount = () => layerState.window?.days.length ?? 0;

  function apply() {
    parts.rendering.apply(layerState.position);
    parts.presenter.refresh();
  }

  function stopTicking() {
    if (frameId !== null) animation.cancel(frameId);
    frameId = null;
    lastTime = null;
  }

  function tick(time) {
    frameId = null;
    const days = dayCount();
    if (!days || !layerState.enabled) return;
    const elapsed = lastTime === null ? 0 : Math.max(0, time - lastTime);
    lastTime = time;
    if (seek) {
      if (seek.start === null) seek.start = time;
      const t = Math.min(1, (time - seek.start) / SEEK_DURATION_MS);
      layerState.position = seek.from + (seek.to - seek.from) * easeInOut(t);
      if (t >= 1) seek = null;
    } else if (layerState.playing) {
      const next = layerState.position + elapsed / DAY_DURATION_MS;
      layerState.position = next >= days + END_HOLD_DAYS ? 0 : next;
    }
    apply();
    if (seek || layerState.playing) frameId = animation.request(tick);
    else lastTime = null;
  }

  function startTicking() {
    if (frameId === null) frameId = animation.request(tick);
  }

  return {
    /** Start a freshly loaded window from its first day. */
    begin({ play = true } = {}) {
      seek = null;
      layerState.position = 0;
      layerState.playing = play && dayCount() > 1;
      apply();
      if (layerState.playing) startTicking();
    },

    stop() {
      stopTicking();
      seek = null;
      layerState.playing = false;
    },

    togglePlay() {
      if (!dayCount()) return;
      layerState.playing = !layerState.playing;
      if (layerState.playing) {
        seek = null;
        if (layerState.position >= dayCount()) layerState.position = 0;
        startTicking();
      }
      apply();
    },

    /**
     * Glide to the middle of a day and pause there.
     * @param {number} index Window day.
     */
    seekDay(index) {
      const days = dayCount();
      if (!days) return;
      const target = Math.min(days - 1, Math.max(0, Math.round(index))) + 0.5;
      layerState.playing = false;
      // Start from the last animation frame when one is running, so the glide
      // moves on its first tick rather than one frame late.
      seek = { from: layerState.position, to: target, start: lastTime };
      startTicking();
      apply();
    },
  };
}
