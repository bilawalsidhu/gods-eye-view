import { defineStore } from 'pinia';
import { onScopeDispose, shallowRef } from 'vue';
import { worldClock } from '../../time/worldClock.js';

/** How often a shown timeline moves its readout and its end on with now. */
const LIVE_TICK_MS = 1000;
/** A scrub this close to now, as a share of the track, is a scrub to live. */
const LIVE_EDGE = 0.005;
/** The least that counts as at now, past the readout's own second. */
const LIVE_EDGE_MS = 5000;

/**
 * The world clock as the timeline shows it: `{live, playing, timeMs,
 * supported, span}`, where `supported` says a layer that moves with the clock
 * has time to show and `span` is the stretch the timeline runs over: the
 * time those layers cover, reaching to now and to the world time, with their
 * marks. It follows the page's world clock, which tells it of every move, and
 * of the time a few times a second while it plays on its own. While a
 * timeline shows, it reads the clock each second itself, so live and the
 * track's end keep up with now.
 */
export const useWorldTimeStore = defineStore('gev-world-time', () => {
  const spanOf = (state) => {
    if (!state.supported) return null;
    const coverage = worldClock.coverage();
    if (!coverage) return null;
    const now = worldClock.wallNow();
    return Object.freeze({
      start: Math.min(coverage.start, now, state.timeMs),
      end: Math.max(coverage.end, now, state.timeMs),
      marks: coverage.marks,
    });
  };
  const read = (state = worldClock.getState()) =>
    Object.freeze({
      live: state.live,
      playing: state.playing,
      timeMs: state.timeMs,
      supported: state.supported,
      span: spanOf(state),
    });
  const time = shallowRef(read());
  let ticker = null;
  const syncTicker = () => {
    // Playing, the clock tells of the time itself.
    const ticking = Boolean(time.value.span) && !time.value.playing;
    if (ticking && ticker === null)
      ticker = setInterval(() => {
        time.value = read();
      }, LIVE_TICK_MS);
    else if (!ticking && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
  const unsubscribe = worldClock.subscribe((state) => {
    time.value = read(state);
    syncTicker();
  });
  syncTicker();
  onScopeDispose(() => {
    unsubscribe();
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  });

  return {
    time,
    togglePlay: () => worldClock.togglePlay(),
    goLive: () => worldClock.goLive(),
    /** Scrub to `ms`: playback stops where the hand puts it; at now, live. */
    scrub(ms) {
      const span = time.value.span;
      const edge = span ? (span.end - span.start) * LIVE_EDGE : 0;
      if (Math.abs(ms - worldClock.wallNow()) <= Math.max(LIVE_EDGE_MS, edge)) {
        worldClock.goLive();
        return;
      }
      worldClock.pause();
      worldClock.seek(ms);
    },
  };
});
