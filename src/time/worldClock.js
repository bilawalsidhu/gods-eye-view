/**
 * The world's one time, in epoch ms. Every layer that draws something at a
 * moment reads it here instead of calling `Date.now()` itself, so layers can
 * never disagree about when the world is.
 *
 * Live is a mode, not a timestamp: while live the clock is the wall clock and
 * every layer behaves as it would reading `Date.now()`. Away from live the
 * clock holds a cursor, fixed or playing. Only the layers that follow the clock
 * (`follow(id)`) move with the cursor; the rest keep reading the live edge
 * through `timeFor(id)`, so a host opts layers in one at a time.
 *
 * Playback is continuous (`cursor + elapsed × rate`) unless a driver takes
 * it: weather replay steps its observed frames itself and moves the clock as
 * it goes, so play and pause hand over to it. Several drivers may be attached;
 * play goes to the newest that can play, pause to the one playing.
 */

/** The span a JS Date can hold, either side of 1970. */
const MAX_DATE_MS = 8.64e15;

/** Whether `ms` is a time the world clock can hold. */
export const isWorldTime = (ms) =>
  Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;

/** How often subscribers hear of a continuously playing cursor. */
export const WORLD_CLOCK_TICK_MS = 250;

/**
 * @param {{now?: () => number, monotonicNow?: () => number,
 *   setInterval?: typeof globalThis.setInterval,
 *   clearInterval?: typeof globalThis.clearInterval}} [options]
 */
export function createWorldClock({
  // Read at each call, so a stand-in for Date.now (a test's, a harness's)
  // reaches every layer as it did when they called Date.now themselves.
  now = () => Date.now(),
  monotonicNow = () => globalThis.performance.now(),
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
} = {}) {
  const listeners = new Set();
  // Layers a host follows, and layers a part of the app holds following.
  const following = new Set();
  const holds = new Map();
  const readers = new Map();
  const sources = new Set();
  const drivers = [];
  let live = true;
  // The cursor while fixed; while playing continuously, the cursor at `anchorMono`.
  let cursorMs = null;
  let anchorMono = 0;
  let rate = 1;
  let playing = false;
  // The driver handle stepping the clock, or null.
  let active = null;
  let ticker = null;
  let notifying = 0;

  const continuous = () => playing && !active;
  const isFollowed = (id) => following.has(id) || (holds.get(id) ?? 0) > 0;
  const followedIds = () => [
    ...new Set([...following, ...[...holds.keys()].filter(isFollowed)]),
  ];
  const time = () => {
    if (live) return now();
    if (continuous()) return cursorMs + (monotonicNow() - anchorMono) * rate;
    return cursorMs;
  };
  const getState = () =>
    Object.freeze({
      live,
      timeMs: time(),
      playing,
      rate,
      following: followedIds(),
    });
  // Each listener hears the state as it is when called. A change made from
  // inside a listener notifies everyone afresh, and the outer round stops, so
  // nobody is left holding a state that has since changed.
  const notify = () => {
    const round = ++notifying;
    for (const listener of [...listeners]) {
      if (round !== notifying) return;
      if (!listeners.has(listener)) continue;
      try {
        listener(getState());
      } catch (error) {
        console.error('World clock listener failed', error);
      }
    }
  };
  const syncTicker = () => {
    if (continuous() && listeners.size) {
      ticker ??= setInterval(notify, WORLD_CLOCK_TICK_MS);
    } else if (ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
  const changed = () => {
    syncTicker();
    notify();
  };
  // Freeze a continuously playing cursor where it is.
  const settle = () => {
    if (continuous()) cursorMs = time();
    anchorMono = monotonicNow();
  };

  const api = {
    /** The live edge: the wall clock, whatever the cursor does. */
    wallNow: () => now(),
    /** The world time: the wall clock while live, else the cursor. */
    now: time,
    isLive: () => live,
    isPlaying: () => playing,
    getRate: () => rate,

    /** Hold the world at `ms`; a playing clock plays on from there. */
    seek(ms) {
      if (!isWorldTime(ms)) throw new TypeError('World time must be epoch ms');
      if (!live && cursorMs === ms && !continuous()) return;
      live = false;
      cursorMs = ms;
      anchorMono = monotonicNow();
      changed();
    },
    /** Back to the wall clock; playback stops. */
    goLive() {
      if (live && !playing) return;
      const stepping = active;
      live = true;
      cursorMs = null;
      playing = false;
      active = null;
      // Its driven(false) finds nothing left to stop.
      stepping?.driver.pause();
      changed();
    },
    /** Play from the cursor (from now, when live). */
    play({ rate: nextRate } = {}) {
      if (nextRate !== undefined) api.setRate(nextRate);
      if (playing) return;
      for (let index = drivers.length - 1; index >= 0; index -= 1) {
        if (drivers[index].driver.play() !== false) return;
      }
      if (live) {
        live = false;
        cursorMs = now();
      }
      playing = true;
      anchorMono = monotonicNow();
      changed();
    },
    pause() {
      if (!playing) return;
      if (active) {
        active.driver.pause();
        return;
      }
      settle();
      playing = false;
      changed();
    },
    togglePlay() {
      return playing ? api.pause() : api.play();
    },
    /** Simulated ms per real ms for continuous playback. */
    setRate(nextRate) {
      if (!Number.isFinite(nextRate) || nextRate <= 0)
        throw new RangeError('World clock rate must be positive');
      if (nextRate === rate) return;
      settle();
      rate = nextRate;
      changed();
    },

    /**
     * Offer a stepping player. The driver moves the clock with `seek()` and
     * reports through its handle's `driven(playing, atMs?)`; its `play()`
     * returns false when it cannot play, and the clock tries an older driver
     * or plays continuously instead.
     * @param {{play: () => (boolean|void), pause: () => void}} driver
     * @returns {{driven: (playing: boolean, atMs?: number) => void,
     *   detach: () => number}} `detach()` returns how many drivers remain.
     */
    attachDriver(driver) {
      const handle = {
        driver,
        /** This driver started stepping (at `atMs`, if given) or stopped. */
        driven(isPlaying, atMs) {
          if (!drivers.includes(handle)) return;
          if (!isPlaying) {
            if (active !== handle) return;
            active = null;
            playing = false;
            changed();
            return;
          }
          // A continuous run hands over where it is; another driver stops.
          settle();
          const previous = active;
          active = handle;
          playing = true;
          live = false;
          if (Number.isFinite(atMs)) cursorMs = atMs;
          else cursorMs ??= now();
          anchorMono = monotonicNow();
          if (previous && previous !== handle) previous.driver.pause();
          changed();
        },
        detach() {
          const index = drivers.indexOf(handle);
          if (index < 0) return drivers.length;
          handle.driven(false);
          drivers.splice(index, 1);
          return drivers.length;
        },
      };
      drivers.push(handle);
      return handle;
    },

    /** Let layer `id` move with the cursor instead of reading the live edge. */
    follow(id, on = true) {
      if (on === following.has(id)) return;
      if (on) following.add(id);
      else following.delete(id);
      changed();
    },
    /**
     * Keep layer `id` following until the returned release is called, however
     * many parts of the app hold it.
     */
    hold(id) {
      const was = isFollowed(id);
      holds.set(id, (holds.get(id) ?? 0) + 1);
      if (!was) changed();
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        const count = holds.get(id) - 1;
        if (count > 0) holds.set(id, count);
        else holds.delete(id);
        if (!isFollowed(id)) changed();
      };
    },
    follows: isFollowed,
    /**
     * The time layer `id` draws at: the cursor when it follows the clock,
     * otherwise the live edge.
     * @returns {() => number}
     */
    timeFor(id) {
      let reader = readers.get(id);
      if (!reader) {
        reader = () => (isFollowed(id) ? time() : now());
        readers.set(id, reader);
      }
      return reader;
    },

    /**
     * A layer's span of time it can show, for a host's timeline; null while
     * it has none (off, or nothing loaded). Returns the unregister.
     * @param {{id: string, coverage: () => ({start: number, end: number, marks?: number[]} | null)}} source
     */
    register(source) {
      // Each registration is its own, even under a shared id.
      const entry = { source };
      sources.add(entry);
      return () => sources.delete(entry);
    },
    /** The union of the registered sources' coverage, or null with none. */
    coverage() {
      let start = Infinity;
      let end = -Infinity;
      const marks = new Set();
      for (const { source } of sources) {
        const span = source.coverage();
        if (!span || !(span.end >= span.start)) continue;
        start = Math.min(start, span.start);
        end = Math.max(end, span.end);
        for (const mark of span.marks ?? []) marks.add(mark);
      }
      if (start > end) return null;
      return { start, end, marks: [...marks].sort((a, b) => a - b) };
    },

    getState,
    subscribe(listener) {
      listeners.add(listener);
      syncTicker();
      return () => {
        listeners.delete(listener);
        syncTicker();
      };
    },
  };
  return api;
}

/** The page's world clock. Layers, the sky and a host all read this one. */
export const worldClock = createWorldClock();

/** The time layer `id` draws at on the page's clock. */
export const worldTimeFor = (id) => worldClock.timeFor(id);
