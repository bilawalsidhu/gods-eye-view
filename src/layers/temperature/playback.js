import { monthIndex } from './dates.js';
import { dominantFrame } from './filmstrip.js';
import { FIRST_YEAR, MONTH_DURATION_MS, SEEK_DURATION_MS } from './policy.js';
import { scaleReading } from './scale.js';

/** Browser animation clock; tests inject their own. */
const BROWSER_ANIMATION = Object.freeze({
  request: (callback) => globalThis.requestAnimationFrame(callback),
  cancel: (id) => globalThis.cancelAnimationFrame(id),
});

/** @param {number} t Unit interval. @returns {number} Ease-in-out. */
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Year playback over published monthly means.
 *
 * The playhead is continuous, not a frame index: it advances every animation
 * frame and the filmstrip blends the two frames either side of it, so months
 * flow into each other instead of cutting. Clicked months glide to their frame
 * the same way, and a new year keeps the month on screen. The frame most on
 * screen is the layer's current frame — the one the on-map month, the layer
 * row and a pinned reading describe.
 */
export function createPlayback({ state: layerState, services, parts, source }) {
  const animation = services.animation ?? BROWSER_ANIMATION;
  let frameId = null;
  let lastTime = null;
  /** Active glide: `{from, to, start}`, or null. */
  let seek = null;

  function notify() {
    parts.indicator?.render(view());
  }

  function years() {
    const latestYear = Number(layerState.latest?.slice(0, 4));
    if (!Number.isInteger(latestYear)) return [];
    return Array.from(
      { length: latestYear - FIRST_YEAR + 1 },
      (_, index) => FIRST_YEAR + index,
    );
  }

  function active() {
    return layerState.playback?.dates?.length && layerState.filmstrip
      ? layerState.playback
      : null;
  }

  /** @returns {object} What the on-map panel draws. */
  function view() {
    const playback = active();
    const dates = playback?.dates ?? [];
    return {
      years: years(),
      year: playback?.year ?? null,
      loadingYear: layerState.playbackLoading,
      error: layerState.playbackError,
      dates,
      position: playback?.position ?? 0,
      dominant: playback ? dominantFrame(dates.length, playback.position) : -1,
      playing: Boolean(playback?.playing),
      reading:
        layerState.sample?.outcome === 'measured'
          ? scaleReading(layerState.sample.stop)
          : null,
    };
  }

  /** Blend to the playhead and move the current frame when it changes. */
  function apply() {
    const playback = active();
    if (!playback) return;
    parts.filmstrip.setPosition(playback.position);
    const date =
      playback.dates[dominantFrame(playback.dates.length, playback.position)];
    if (layerState.date === date) {
      parts.indicator?.render(view());
      return;
    }
    layerState.date = date;
    // A reading stays pinned to its point and follows the frame, so a clicked
    // spot can be watched through the whole year.
    void parts.sampling.refreshReadout();
    notify();
  }

  function stopTicking() {
    if (frameId !== null) animation.cancel(frameId);
    frameId = null;
    lastTime = null;
  }

  function tick(time) {
    frameId = null;
    const playback = active();
    if (!playback) return;
    const elapsed = lastTime === null ? 0 : Math.max(0, time - lastTime);
    lastTime = time;
    if (seek) {
      if (seek.start === null) seek.start = time;
      const t = Math.min(1, (time - seek.start) / SEEK_DURATION_MS);
      playback.position = seek.from + (seek.to - seek.from) * easeInOut(t);
      if (t >= 1) seek = null;
    } else if (playback.playing) {
      playback.position =
        (playback.position + elapsed / MONTH_DURATION_MS) %
        playback.dates.length;
    }
    apply();
    if (seek || playback.playing) frameId = animation.request(tick);
    else lastTime = null;
  }

  function startTicking() {
    if (frameId === null) frameId = animation.request(tick);
  }

  /** Stop playback and drop its frames; the layer is being switched off. */
  function release() {
    stopTicking();
    seek = null;
    layerState.playbackAbort?.abort();
    layerState.playbackAbort = null;
    parts.filmstrip.clear();
    parts.indicator?.hide();
    layerState.playback = null;
    layerState.playbackLoading = null;
    layerState.playbackError = null;
    layerState.date = null;
  }

  /**
   * Load a year and play it. The year on screen keeps playing underneath
   * until the new one has loaded, and the month carries over.
   * @param {number} year Calendar year.
   * @returns {Promise<boolean>} Whether the year is now on screen.
   */
  async function selectYear(year) {
    if (!layerState.enabled || !layerState.viewer || !layerState.latest)
      return false;
    if (layerState.playback?.year === year && !layerState.playbackLoading)
      return true;
    layerState.playbackAbort?.abort();
    const request = new AbortController();
    layerState.playbackAbort = request;
    layerState.playbackLoading = year;
    layerState.playbackError = null;
    notify();
    const current = () =>
      !request.signal.aborted && layerState.playbackAbort === request;
    try {
      const { dates } = await source.resolveYear({
        year,
        latest: layerState.latest,
        signal: request.signal,
      });
      if (!current()) return false;
      const loaded = await parts.filmstrip.load(dates, {
        signal: request.signal,
      });
      if (!current() || !loaded) return false;
      const previous = active();
      const month = layerState.date ? monthIndex(layerState.date) : -1;
      const keep = dates.findIndex((date) => monthIndex(date) === month);
      seek = null;
      layerState.playback = {
        year,
        dates,
        position: keep >= 0 ? keep : 0,
        // One frame is a still, not a playback.
        playing: dates.length > 1 && (previous ? previous.playing : true),
      };
      layerState.playbackLoading = null;
      layerState.date = null;
      apply();
      if (layerState.playback.playing) startTicking();
      return true;
    } catch (error) {
      if (!current() || error?.name === 'AbortError') return false;
      layerState.playbackError =
        error?.message || `Surface temperature for ${year} unavailable`;
      throw error;
    } finally {
      if (layerState.playbackAbort === request) {
        layerState.playbackAbort = null;
        layerState.playbackLoading = null;
      }
      notify();
    }
  }

  function setPlaying(playing) {
    const playback = active();
    if (!playback || playback.dates.length < 2 || playback.playing === playing)
      return;
    playback.playing = playing;
    if (playing) {
      seek = null;
      startTicking();
    }
    notify();
  }

  /**
   * Glide to a frame and pause there.
   * @param {number} index Target frame; wraps.
   */
  function seekTo(index) {
    const playback = active();
    if (!playback) return;
    const count = playback.dates.length;
    const target = ((Math.round(index) % count) + count) % count;
    playback.playing = false;
    // Glide the short way round, so December to January is one step.
    let from = playback.position;
    if (target - from > count / 2) from += count;
    else if (from - target > count / 2) from -= count;
    // Start from the last animation frame when one is running, so the glide
    // moves on its first tick rather than one frame late.
    seek = { from, to: target, start: lastTime };
    startTicking();
    notify();
  }

  return {
    selectYear,
    release,
    view,
    seekTo,
    /** @param {number} month Month of the year, 0-based. */
    seekMonth(month) {
      const index =
        active()?.dates.findIndex((date) => monthIndex(date) === month) ?? -1;
      if (index >= 0) seekTo(index);
    },
    togglePlay: () => setPlaying(!active()?.playing),
    /** Redraw the panel after something it shows changed, e.g. a reading. */
    refreshPanel() {
      if (active()) notify();
    },
  };
}
