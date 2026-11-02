import { defineStore } from 'pinia';
import { onScopeDispose, shallowRef } from 'vue';
import { worldClock } from '../../time/worldClock.js';

/** How often a shown timeline moves its readout and its end on with now. */
const LIVE_TICK_MS = 1000;
/** A scrub this close to now, as a share of the track, is a scrub to live. */
const LIVE_EDGE = 0.005;
/** The least that counts as at now, past the readout's own second. */
const LIVE_EDGE_MS = 5000;
/** How long play takes to run the whole track, in real ms. */
const PLAY_THROUGH_MS = 60_000;

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
  // The time the layers cover, reaching to now.
  const reach = () => {
    const coverage = worldClock.coverage();
    if (!coverage) return null;
    const now = worldClock.wallNow();
    return {
      start: Math.min(coverage.start, now),
      end: Math.max(coverage.end, now),
      marks: coverage.marks,
    };
  };
  const spanOf = (state) => {
    if (!state.supported) return null;
    const covered = reach();
    if (!covered) return null;
    return Object.freeze({
      start: Math.min(covered.start, state.timeMs),
      end: Math.max(covered.end, state.timeMs),
      marks: covered.marks,
    });
  };
  const nearNow = (ms, span) =>
    Math.abs(ms - worldClock.wallNow()) <=
    Math.max(LIVE_EDGE_MS, span ? (span.end - span.start) * LIVE_EDGE : 0);
  // Whether the track ends at now (and moves on with it), not past it.
  const endsAtNow = (covered) =>
    covered.end - worldClock.wallNow() <= LIVE_EDGE_MS;
  // Play stops at the end of the track: at now it goes live, past now (a
  // satellite's future) it holds there.
  let stopping = false;
  const stopAtEnd = (state) => {
    if (stopping || !state.playing || state.live || !state.supported)
      return false;
    const covered = reach();
    if (!covered || state.timeMs < covered.end) return false;
    stopping = true;
    try {
      if (endsAtNow(covered)) worldClock.goLive();
      else {
        // Back to the end first, so nothing hears the overshoot as paused.
        worldClock.seek(covered.end);
        worldClock.pause();
        worldClock.seek(covered.end);
      }
    } finally {
      stopping = false;
    }
    return true;
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
    if (stopAtEnd(state)) return;
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
    /**
     * Play runs the whole track in about a minute, from the start when it is
     * at its end (at live, say), as a video plays again from the top. It runs
     * the clock itself, past weather's own replay: weather follows the time
     * frame by frame like every other layer the track covers.
     */
    togglePlay() {
      const { playing, live, timeMs, span } = time.value;
      if (playing) return worldClock.pause();
      const covered = reach();
      if (!span || !covered) return worldClock.play({ rate: 1 });
      const length = span.end - span.start;
      if (live || timeMs >= covered.end - LIVE_EDGE_MS)
        worldClock.seek(span.start);
      // An end at now moves on with it, so play outruns it by the track.
      const rate = endsAtNow(covered)
        ? 1 + length / PLAY_THROUGH_MS
        : Math.max(1, length / PLAY_THROUGH_MS);
      worldClock.play({ rate, continuous: true });
    },
    goLive: () => worldClock.goLive(),
    /** Scrub to `ms`: playback stops where the hand puts it; at now, live. */
    scrub(ms) {
      if (nearNow(ms, time.value.span)) {
        worldClock.goLive();
        return;
      }
      worldClock.pause();
      worldClock.seek(ms);
    },
  };
});
