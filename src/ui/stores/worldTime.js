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
 * The most that counts as at now, however long the track: on a track that
 * runs over years, a share of it would take whole days back to live.
 */
const LIVE_EDGE_MAX_MS = 2 * 60_000;
/** The speeds play offers, in world ms per real ms. */
export const WORLD_TIME_SPEEDS = Object.freeze({
  real: 1,
  minute: 60,
  hour: 3_600,
  day: 86_400,
  week: 604_800,
});

/**
 * The world clock as the timeline shows it: `{live, playing, stepping,
 * buffering, timeMs, supported, span}`, where `supported` says a layer that moves with the clock
 * has time to show and `span` is the stretch the timeline runs over: the
 * time those layers cover, reaching to now and to the world time, with their
 * marks (`marks`, their times; `markDetails`, each `{time, label?, id?,
 * kind?}`, as the world clock's coverage gives them). It follows the page's world clock, which tells it of every move, and
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
      markDetails: coverage.markDetails,
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
      markDetails: covered.markDetails,
    });
  };
  const nearNow = (ms, length) =>
    Math.abs(ms - worldClock.wallNow()) <=
    Math.max(LIVE_EDGE_MS, Math.min(LIVE_EDGE_MAX_MS, length * LIVE_EDGE));
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
      stepping: state.stepping,
      buffering: state.buffering,
      timeMs: state.timeMs,
      supported: state.supported,
      span: spanOf(state),
    });
  const time = shallowRef(read());
  // The speed shown follows the world clock's rate, whoever set it: a rate
  // not among those offered shows as the nearest that is (by ratio), while
  // play still runs at the clock's own rate.
  const speedFor = (clockRate) => {
    let best = 'real';
    for (const key of Object.keys(WORLD_TIME_SPEEDS))
      if (
        Math.abs(Math.log(WORLD_TIME_SPEEDS[key] / clockRate)) <
        Math.abs(Math.log(WORLD_TIME_SPEEDS[best] / clockRate))
      )
        best = key;
    return best;
  };
  const speed = shallowRef(speedFor(worldClock.getRate()));
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
    if (speed.value !== speedFor(state.rate))
      speed.value = speedFor(state.rate);
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
     * Play runs the track at the world clock's rate (the speed chosen, which
     * sets it), from where the clock is, or from the start when it is paused
     * at the track's end, as a video plays again from the top. At live it
     * does nothing: the clock is already at now, running with the world. It
     * runs the clock itself: weather follows the time frame by frame like
     * every other layer the track covers.
     */
    togglePlay() {
      const { playing, live, timeMs, span } = time.value;
      if (playing) return worldClock.pause();
      if (live) return;
      const covered = reach();
      if (span && covered && timeMs >= covered.end) worldClock.seek(span.start);
      // At the clock's rate: the speed chosen, or a host's own.
      worldClock.play({ continuous: true });
    },
    speed,
    /**
     * Choose how fast play runs: the world clock keeps it, so any play runs
     * at it (a layer's own Play too), and playing, it changes at once. A
     * driver steps at its own pace, so a speed chosen while one plays takes
     * playback over from where it is.
     */
    setSpeed(next) {
      if (!Object.hasOwn(WORLD_TIME_SPEEDS, next)) return;
      speed.value = next;
      // The clock's rate first: the speed shown follows it from here on.
      worldClock.setRate(WORLD_TIME_SPEEDS[next]);
      const { playing, stepping } = worldClock.getState();
      if (!playing || !stepping) return;
      worldClock.pause();
      worldClock.play({ continuous: true });
    },
    goLive: () => worldClock.goLive(),
    /**
     * Scrub to `ms`: playback stops where the hand puts it; at now, live.
     * How near now counts as now goes by `length`, the stretch the track
     * shows, all of the span unless it is zoomed.
     */
    scrub(ms, length) {
      const span = time.value.span;
      length ??= span ? span.end - span.start : 0;
      if (nearNow(ms, length)) {
        worldClock.goLive();
        return;
      }
      worldClock.pause();
      worldClock.seek(ms);
    },
  };
});
