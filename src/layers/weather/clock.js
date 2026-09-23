export const RADAR_MAX_GAP_MS = 30 * 60_000;
export const REGIONAL_INFRARED_MAX_GAP_MS = 30 * 60_000;
export const GLOBAL_INFRARED_MAX_GAP_MS = 3 * 60 * 60_000;
export const LIGHTNING_MAX_GAP_MS = 30 * 60_000;

/** Transient observed time. Products must honor the signal before installing a frame. */
export function createWeatherClock({
  now = Date.now,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
} = {}) {
  const registry = new Map();
  const listeners = new Set();
  let mode = 'latest';
  let target = null;
  let playing = false;
  let generation = 0;
  let timer = null;
  let pending = null;
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
  function schedule() {
    cancelTimer();
    if (!playing || destroyed || pending) return;
    if (!canPlay()) {
      playing = false;
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
    if (!canPlay()) playing = false;
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
      pending = null;
      if (!canPlay()) playing = false;
      notify();
      schedule();
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
      void api.refresh();
      return () => {
        if (registry.get(product.id) !== entry) return;
        entry.controller?.abort();
        registry.delete(product.id);
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
      mode = 'history';
      target = normalized;
      return transition();
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
      mode = 'latest';
      target = null;
      playing = false;
      return transition();
    },
    play() {
      if (destroyed || playing || !canPlay())
        return pending ?? Promise.resolve(false);
      playing = true;
      if (mode === 'latest') {
        const timeline = getTimeline();
        return api.setTarget(
          timeline.findLast((time) => Date.parse(time) <= now()) ?? timeline[0],
        );
      }
      notify();
      schedule();
      return pending ?? Promise.resolve(true);
    },
    pause() {
      cancelTimer();
      if (!playing) return;
      playing = false;
      notify();
    },
    togglePlay() {
      return playing ? api.pause() : api.play();
    },
    refresh() {
      if (destroyed) return Promise.resolve(false);
      if (!canPlay()) {
        playing = false;
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
      destroyed = true;
      ++generation;
      playing = false;
      cancelTimer();
      for (const entry of registry.values()) entry.controller?.abort();
      registry.clear();
      listeners.clear();
      pending = null;
    },
  };
  return api;
}
