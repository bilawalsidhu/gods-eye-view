import { createWorldClock } from '../../time/worldClock.js';

export const RADAR_MAX_GAP_MS = 30 * 60_000;
export const REGIONAL_INFRARED_MAX_GAP_MS = 30 * 60_000;
export const GLOBAL_INFRARED_MAX_GAP_MS = 3 * 60 * 60_000;
export const LIGHTNING_MAX_GAP_MS = 30 * 60_000;
/** How many of a feed's latest frames say how far apart its frames come. */
const SPACING_FRAMES = 12;
/** A frame holds this many of its feed's frame spacings before it lapses. */
const SPACING_SLACK = 1.5;

/**
 * How far apart a feed's frames come: the median spacing of its latest
 * frames, in ms, or null with fewer than two. Takes UTC times or epoch ms.
 * @param {Array<string|number>} times
 * @returns {number|null}
 */
export function frameSpacingMs(times) {
  const at = [
    ...new Set(
      (times ?? [])
        .map((time) => (typeof time === 'number' ? time : Date.parse(time)))
        .filter(Number.isFinite),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(-(SPACING_FRAMES + 1));
  if (at.length < 2) return null;
  const gaps = at
    .slice(1)
    .map((time, i) => time - at[i])
    .sort((a, b) => a - b);
  const middle = gaps.length >> 1;
  return gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2;
}

/**
 * A product's least time, `leastMs`, held to its feed's own frame spacing:
 * never less than one and a half spacings, so a feed whose frames come an
 * hour apart covers the whole hour between them, while one with frames
 * minutes apart keeps `leastMs`.
 * @param {number} leastMs
 * @param {Array<string|number>} times
 * @returns {number}
 */
export function atLeastFrameSpacing(leastMs, times) {
  const spacing = frameSpacingMs(times);
  return spacing === null
    ? leastMs
    : Math.max(leastMs, spacing * SPACING_SLACK);
}

/** The longest play waits on a frame before it goes on without it. */
export const PLAY_WAIT_MS = 8_000;
// Playing on its own, the world does not wait on the frame it is at: that
// frame loads as play goes on. Play holds only at the next frame while the
// one before it still loads, then goes on to it once it shows, so every frame
// shows, play stops only for a load that is slow, and a frame loaded ahead
// costs play nothing.

let clocks = 0;
// How many weather clocks follow each world clock.
const followers = new WeakMap();

/**
 * Transient observed time. Products must honor the signal before installing a
 * frame. Its time is the world clock's: latest while the world is live,
 * history at the world's time otherwise. It never moves the world clock
 * itself; the world's own controls (its timeline) move time, and while the
 * world plays it stops at each next frame until that frame loads.
 *
 * `shared` (the default) is a clock several layers share, such as the
 * catalog's: the last shared clock destroyed leaves the world live. A clock
 * one layer keeps for itself (`shared: false`) leaves the world's time where
 * it is.
 */
export function createWeatherClock({
  now = Date.now,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  world = createWorldClock({ now }),
  shared = true,
} = {}) {
  const registry = new Map();
  const listeners = new Set();
  let mode = 'latest';
  let target = null;
  // The world time last applied.
  let seen = 'latest';
  const releases = new Map();
  let generation = 0;
  let pending = null;
  // This clock's name on the world, for its holds and its gate.
  const holdId = `weather:${++clocks}`;
  // While the world plays, the hold on it at the next frame as the one before
  // it loads, and the timer that lets play go on should that frame never
  // come; and whether the move to the next frame waits on it.
  let waiting = null;
  let waitTimer = null;
  let deferred = false;
  // How long a frame takes to show while playing (a running mean), so play
  // at a pace frames cannot keep up with steps over some rather than stop at
  // each: as a video drops frames on a slow link, it shows every frame it can
  // load in time, each at its own time.
  let loadMs = null;
  let transitionStarted = null;
  const stride = (state = world.getState()) => {
    if (!worldPlaysOn(state) || !(loadMs > 0)) return 1;
    const times = getTimeline().map((time) => Date.parse(time));
    const at = Math.floor(state.timeMs);
    const index = times.findIndex((time) => time > at);
    if (index < 0 || index + 1 >= times.length) return 1;
    const spacing = times[index + 1] - times[index];
    if (!(spacing > 0)) return 1;
    // Real ms between frames at this rate, against the time one takes.
    const realSpacing = spacing / Math.max(1e-6, state.rate || 1);
    return Math.max(1, Math.min(12, Math.ceil((loadMs * 1.15) / realSpacing)));
  };
  const stopWaiting = () => {
    const release = waiting;
    waiting = null;
    if (waitTimer !== null) clearTimeout(waitTimer);
    waitTimer = null;
    release?.();
  };
  const startWaiting = () => {
    if (waiting || destroyed || !registry.size) return;
    waiting = world.wait(holdId);
    waitTimer = setTimeout(() => {
      waitTimer = null;
      stopWaiting();
      // The frame that never came gives way to the one play is at.
      if (deferred) void transition();
    }, PLAY_WAIT_MS);
  };
  // Playing on its own, the world waits for frames as they load.
  const worldPlaysOn = (state = world.getState()) =>
    state.playing && !state.live && !state.stepping;
  let destroyed = false;
  const timesFor = (product) =>
    [...new Set(product.getTimes())]
      .filter((time) => Number.isFinite(Date.parse(time)))
      .sort((a, b) => Date.parse(a) - Date.parse(b));
  const getTimeline = () =>
    [
      ...new Set(
        [...registry.values()].flatMap(({ product }) =>
          product.isSuspended() ? [] : timesFor(product),
        ),
      ),
    ].sort((a, b) => Date.parse(a) - Date.parse(b));
  function selectFor(id, time) {
    const product = registry.get(id)?.product;
    if (!product) return null;
    const at = Date.parse(time);
    return (
      timesFor(product).findLast((candidate) => {
        const age = at - Date.parse(candidate);
        return age >= 0 && age <= product.maxGapMs;
      }) ?? null
    );
  }
  const selectedFor = (product) =>
    mode === 'latest'
      ? (timesFor(product).at(-1) ?? null)
      : selectFor(product.id, target);
  const getState = () => ({
    mode,
    target,
    // Frames come on one after another as the world plays on through them,
    // so the next is worth loading ahead.
    advancing: worldPlaysOn(),
    // How many frames on play gets to next: more than one where frames load
    // slower than play reaches them, which is the one worth loading ahead.
    stride: stride(),
    timeline: getTimeline(),
    products: [...registry.values()].map(({ product }) => ({
      id: product.id,
      shown: product.getShownTime() ?? null,
      selected: selectedFor(product),
      suspended: Boolean(product.isSuspended()),
    })),
  });
  const notify = () => {
    if (!destroyed) for (const listener of listeners) listener(getState());
  };
  const selections = () =>
    [...registry.values()].map(({ product }) => selectedFor(product)).join();
  let applied = null;
  function transition() {
    if (destroyed) return Promise.resolve(false);
    const owner = ++generation;
    // A scrub drops what loads and moves on; play goes on as this loads.
    applied = selections();
    deferred = false;
    stopWaiting();
    const started = performance.now();
    transitionStarted = worldPlaysOn() ? started : null;
    for (const entry of registry.values()) entry.controller?.abort();
    // Start all products together; a rejection must not skip the settle barrier.
    const tasks = [...registry.values()].map((entry) => {
      entry.controller = new AbortController();
      const { signal } = entry.controller;
      const time = selectedFor(entry.product);
      return Promise.resolve().then(() => {
        if (signal.aborted || owner !== generation || destroyed) return false;
        return entry.product.apply(time, { signal });
      });
    });
    const result = Promise.allSettled(tasks).then(() => {
      if (destroyed || owner !== generation) return false;
      if (transitionStarted === started) {
        const took = performance.now() - started;
        loadMs = loadMs === null ? took : loadMs * 0.6 + took * 0.4;
      }
      stopWaiting();
      pending = null;
      notify();
      // Play held at the next frame for this one goes on to it.
      if (deferred) void transition();
      return true;
    });
    pending = result;
    notify();
    return result;
  }
  const api = {
    register(product) {
      if (destroyed) return () => {};
      if (registry.has(product.id))
        throw new Error(`Duplicate weather product: ${product.id}`);
      const entry = { product, controller: null };
      registry.set(product.id, entry);
      // The product moves with the world clock, and the span of its frames is
      // time the world clock's timeline can show while it is on, suspended or
      // not, so the way back to live stays on screen. The frames are not
      // marks: they come every few minutes, and the timeline marks only
      // events. Both calls notify the world's listeners, which may destroy
      // this clock: the release is in place first, and anything acquired
      // after a destroy is let go at once.
      let unhold = null;
      let uncover = null;
      const release = () => {
        uncover?.();
        unhold?.();
        uncover = unhold = null;
      };
      releases.set(product.id, release);
      unhold = world.hold(product.id);
      if (!destroyed)
        uncover = world.register({
          id: product.id,
          coverage: () => {
            const times = timesFor(product);
            return times.length
              ? {
                  start: Date.parse(times[0]),
                  end: Date.parse(times.at(-1)),
                  frames: times.map((time) => Date.parse(time)),
                }
              : null;
          },
        });
      if (destroyed) {
        release();
        return () => {};
      }
      void api.refresh();
      return () => {
        if (registry.get(product.id) !== entry) return;
        entry.controller?.abort();
        registry.delete(product.id);
        releases.get(product.id)?.();
        releases.delete(product.id);
        void api.refresh();
      };
    },
    getTimeline,
    selectFor,
    /**
     * Whether layer `id` follows the world clock (see the world clock's
     * `follows`): a host that follows it for a layer of its own, such as
     * wind, gives that layer the timeline time rather than the live edge.
     */
    follows: (id) => world.follows(id),
    /**
     * The world clock this clock follows. Time moves there, through the same
     * seek, play and live the world's timeline uses, never through this clock.
     */
    world,
    refresh() {
      if (destroyed) return Promise.resolve(false);
      // New frames, or products added or dropped, and with them the next.
      world.coverageChanged();
      gated = undefined;
      gateNext(world.getState());
      if (mode === 'history') return transition();
      notify();
      return Promise.resolve(true);
    },
    getState,
    subscribe(listener) {
      if (!destroyed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      ++generation;
      stopWaiting();
      world.gate(holdId, null);
      unfollowWorld();
      // The last shared weather clock leaves the world live, as a new one
      // expects.
      if (shared) {
        const left = followers.get(world) - 1;
        followers.set(world, left);
        if (left === 0) world.goLive();
      }
      for (const release of releases.values()) release();
      releases.clear();
      for (const entry of registry.values()) entry.controller?.abort();
      registry.clear();
      listeners.clear();
      pending = null;
    },
  };
  // Follow the world clock. A move (a seek, play going on) applies only when
  // it changes the mode or a product's frame.
  function followWorld(state) {
    if (destroyed) return;
    gateNext(state);
    // Play starting or stopping changes whether the next frame loads ahead.
    const playsOn = worldPlaysOn(state);
    const playChanged = playsOn !== playedOn;
    playedOn = playsOn;
    const nextMode = state.live ? 'latest' : 'history';
    const nextTarget = state.live
      ? null
      : new Date(Math.floor(state.timeMs)).toISOString();
    const key = nextTarget ?? 'latest';
    if (key === seen) {
      if (playChanged) notify();
      return;
    }
    seen = key;
    const modeChanged = nextMode !== mode;
    mode = nextMode;
    target = nextTarget;
    if (!modeChanged && selections() === applied) {
      // Back at the frame that loads, play need not hold for it.
      if (deferred) {
        deferred = false;
        stopWaiting();
      }
      // Played through, the time moves each frame with nothing new to show:
      // listeners hear of the frames as they change.
      if (!playsOn || playChanged) notify();
      return;
    }
    // Playing on into the next frame while the one before it loads, the
    // world holds here until that one shows.
    if (!modeChanged && pending && playsOn) {
      deferred = true;
      // Frames that load slower than play reaches them are stepped over:
      // play runs on to the gate a stride ahead, and the newest frame is
      // loaded once this one shows.
      if (stride(state) === 1) startWaiting();
      notify();
      return;
    }
    void transition();
  }
  // Playing on its own, the world stops at each next frame to load it rather
  // than run past frames between its ticks.
  let gated = null;
  let playedOn = false;
  function gateNext(state) {
    let next = null;
    if (worldPlaysOn(state)) {
      const times = getTimeline().map((time) => Date.parse(time));
      const index = times.findIndex((time) => time > Math.floor(state.timeMs));
      if (index >= 0)
        next = times[Math.min(times.length - 1, index + stride(state) - 1)];
    }
    if (next === gated) return;
    gated = next;
    world.gate(holdId, next);
  }
  const unfollowWorld = world.subscribe(followWorld);
  if (shared) followers.set(world, (followers.get(world) ?? 0) + 1);
  followWorld(world.getState());
  return api;
}
