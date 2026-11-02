import { createWorldClock } from '../../time/worldClock.js';

export const RADAR_MAX_GAP_MS = 30 * 60_000;
export const REGIONAL_INFRARED_MAX_GAP_MS = 30 * 60_000;
export const GLOBAL_INFRARED_MAX_GAP_MS = 3 * 60 * 60_000;
export const LIGHTNING_MAX_GAP_MS = 30 * 60_000;
/** The longest play waits on a frame before it goes on without it. */
export const PLAY_WAIT_MS = 8_000;

let clocks = 0;

/**
 * Transient observed time. Products must honor the signal before installing a
 * frame. Its time is the world clock's: latest while the world is live,
 * history at the world's time otherwise. Replay steps the observed frames and
 * moves the world clock as it goes, as the world clock's driver.
 */
export function createWeatherClock({
  now = Date.now,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  world = createWorldClock({ now }),
} = {}) {
  const registry = new Map();
  const listeners = new Set();
  let mode = 'latest';
  let target = null;
  let playing = false;
  // The world time last applied; while this clock moves the world, the
  // transition its move started.
  let seen = 'latest';
  let moving = false;
  let moved = null;
  const releases = new Map();
  // Attached at the end, once the API exists.
  let driver = null;
  let generation = 0;
  let timer = null;
  let pending = null;
  // This clock's name on the world, for its holds and its gate.
  const holdId = `weather:${++clocks}`;
  // While the world plays, the hold on it as frames for its time load, and
  // the timer that lets play go on should a frame never come.
  let waiting = null;
  let waitTimer = null;
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
    playing,
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
  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const canPlay = () => getTimeline().length >= 2;
  const stopPlaying = () => {
    if (!playing) return;
    playing = false;
    driver?.driven(false);
  };
  // Move the world clock; the change comes back through followWorld. Returns
  // the transition the move started, if it started one.
  const move = (fn) => {
    const outer = [moving, moved];
    moving = true;
    moved = null;
    try {
      fn();
      return moved;
    } finally {
      [moving, moved] = outer;
    }
  };
  const selections = () =>
    [...registry.values()].map(({ product }) => selectedFor(product)).join();
  let applied = null;
  function schedule() {
    cancelTimer();
    if (!playing || destroyed || pending) return;
    if (!canPlay()) {
      stopPlaying();
      notify();
      return;
    }
    const owner = generation;
    timer = setTimeout(() => {
      timer = null;
      if (destroyed || !playing || owner !== generation) return;
      const timeline = getTimeline();
      if (timeline.length < 2) {
        api.pause();
        return;
      }
      const next = timeline.find(
        (time) => Date.parse(time) > Date.parse(target),
      );
      void api.setTarget(next ?? timeline[0]);
    }, 2000);
  }
  function transition() {
    if (destroyed) return Promise.resolve(false);
    cancelTimer();
    const owner = ++generation;
    if (!canPlay()) stopPlaying();
    // Playing, the world waits for new frames; a later move takes over the
    // wait, and a scrub (not playing) drops what loads and moves on. A refresh
    // that shows the same frames does not hold play.
    const framesChange = selections() !== applied;
    applied = selections();
    stopWaiting();
    if (framesChange && worldPlaysOn()) startWaiting();
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
      stopWaiting();
      pending = null;
      if (!canPlay()) stopPlaying();
      notify();
      schedule();
      return true;
    });
    pending = result;
    if (moving) moved ??= result;
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
      // The product moves with the world clock, and its frames are time the
      // world clock's timeline can show while it is on, suspended or not, so
      // the way back to live stays on screen. Both calls notify the world's
      // listeners, which may destroy this clock: the release is in place
      // first, and anything acquired after a destroy is let go at once.
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
            const marks = timesFor(product).map((time) => Date.parse(time));
            return marks.length
              ? { start: marks[0], end: marks.at(-1), marks }
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
    setTarget(time) {
      if (destroyed) return Promise.resolve(false);
      if (!Number.isFinite(Date.parse(time)))
        throw new TypeError('Weather target must be a UTC time');
      const normalized = new Date(time).toISOString();
      if (mode === 'history' && target === normalized)
        return pending ?? Promise.resolve(true);
      return (
        move(() => world.seek(Date.parse(normalized))) ??
        pending ??
        Promise.resolve(true)
      );
    },
    step(direction) {
      if (destroyed || ![-1, 1].includes(direction))
        return Promise.resolve(false);
      api.pause();
      const timeline = getTimeline();
      if (!timeline.length) return Promise.resolve(false);
      const at = Date.parse(target ?? timeline.at(-1));
      const next =
        direction < 0
          ? (timeline.findLast((time) => Date.parse(time) < at) ?? timeline[0])
          : (timeline.find((time) => Date.parse(time) > at) ?? timeline.at(-1));
      return api.setTarget(next);
    },
    latest() {
      if (destroyed) return Promise.resolve(false);
      stopPlaying();
      if (mode === 'latest') return transition();
      return move(() => world.goLive()) ?? pending ?? Promise.resolve(true);
    },
    play() {
      if (destroyed || playing || !canPlay())
        return pending ?? Promise.resolve(false);
      playing = true;
      if (mode === 'latest') {
        const timeline = getTimeline();
        const start =
          timeline.findLast((time) => Date.parse(time) <= now()) ?? timeline[0];
        // Playing and at the first frame in one move of the world.
        return (
          move(() => driver.driven(true, Date.parse(start))) ??
          pending ??
          Promise.resolve(true)
        );
      }
      driver.driven(true);
      notify();
      schedule();
      return pending ?? Promise.resolve(true);
    },
    pause() {
      cancelTimer();
      if (!playing) {
        // The world may be playing on its own; a pause or step here holds it.
        if (world.isPlaying()) world.pause();
        return;
      }
      stopPlaying();
      notify();
    },
    togglePlay() {
      return playing ? api.pause() : api.play();
    },
    refresh() {
      if (destroyed) return Promise.resolve(false);
      // New frames, or products added or dropped, and with them the next.
      world.coverageChanged();
      gated = undefined;
      gateNext(world.getState());
      if (!canPlay()) {
        stopPlaying();
        cancelTimer();
      }
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
      stopPlaying();
      destroyed = true;
      ++generation;
      stopWaiting();
      world.gate(holdId, null);
      cancelTimer();
      unfollowWorld();
      // The last weather clock leaves the world live, as a new one expects.
      if (driver.detach() === 0) world.goLive();
      for (const release of releases.values()) release();
      releases.clear();
      for (const entry of registry.values()) entry.controller?.abort();
      registry.clear();
      listeners.clear();
      pending = null;
    },
  };
  // Follow the world clock. A move of this clock's own always applies; one
  // from elsewhere (a host's seek, continuous play) applies only when it
  // changes the mode or a product's frame.
  function followWorld(state) {
    if (destroyed) return;
    gateNext(state);
    // Play pressed while a frame still loads waits for it too.
    const playsOn = worldPlaysOn(state);
    if (playsOn && !playedOn && pending) startWaiting();
    playedOn = playsOn;
    const nextMode = state.live ? 'latest' : 'history';
    const nextTarget = state.live
      ? null
      : new Date(Math.floor(state.timeMs)).toISOString();
    const key = nextTarget ?? 'latest';
    if (key === seen) return;
    seen = key;
    const modeChanged = nextMode !== mode;
    mode = nextMode;
    target = nextTarget;
    if (moving || modeChanged || selections() !== applied) void transition();
    else notify();
  }
  // Playing on its own, the world stops at each next frame to load it rather
  // than run past frames between its ticks.
  let gated = null;
  let playedOn = false;
  function gateNext(state) {
    const next = worldPlaysOn(state)
      ? (getTimeline()
          .map((time) => Date.parse(time))
          .find((time) => time > Math.floor(state.timeMs)) ?? null)
      : null;
    if (next === gated) return;
    gated = next;
    world.gate(holdId, next);
  }
  const unfollowWorld = world.subscribe(followWorld);
  driver = world.attachDriver({
    play: () => (canPlay() ? void api.play() : false),
    pause: () => api.pause(),
  });
  followWorld(world.getState());
  return api;
}
