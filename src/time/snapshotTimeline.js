import { readSnapshotTimeline } from '../sources/live/contract.js';

/** The longest play waits on a snapshot before it goes on without it. */
export const SNAPSHOT_WAIT_MS = 8_000;
/** How long a snapshot that failed to load waits before it is asked again. */
export const SNAPSHOT_RETRY_MS = 5_000;

/**
 * Let a layer of live contacts (flights, military aircraft, vessels) follow
 * the world clock when, and only when, its source declares a timeline: it can
 * answer a snapshot at a given time (see readSnapshotTimeline). With no
 * timeline this does nothing at all: the layer never follows the clock and
 * stays live.
 *
 * While the layer is on, it follows the clock. At the live edge the layer
 * polls as it always has. Away from it the layer is `active()`: it stops
 * polling and shows the snapshots this asks for.
 *
 * - A jump (a seek, time going backwards, leaving live) drops what loads,
 *   holds play, and asks for the snapshot at the step at or before the time;
 *   `load(atMs, {signal, replace: true})` puts it in place of every contact.
 * - Playing on, it stays a snapshot ahead of the time: it asks for the next
 *   step as the clock nears the newest it has, and play does not pass a
 *   snapshot still loading (for at most SNAPSHOT_WAIT_MS). Those snapshots
 *   are applied as polls are (`replace: false`), so contacts move on smoothly.
 * - Outside the source's coverage the layer is `clear()`ed and nothing loads;
 *   while the coverage is not known yet nothing loads and nothing is cleared.
 * - Back at live, the layer is `clear()`ed and `resumeLive()` polls at once.
 *
 * `load` resolves true once the snapshot is applied and false (or rejects)
 * when it could not be; it must not apply anything once `signal` aborts. A
 * rejection named AbortError is a request the source dropped for a newer
 * one: it is not a failure, and nothing is cleared.
 *
 * @param {{id: string, clock: ReturnType<typeof import('./worldClock.js').createWorldClock>,
 *   source: () => object|null,
 *   load: (atMs: number, options: {signal: AbortSignal, replace: boolean}) => Promise<boolean>,
 *   clear: () => void, resumeLive: () => void,
 *   now?: () => number, setTimeout?: typeof globalThis.setTimeout,
 *   clearTimeout?: typeof globalThis.clearTimeout}} options `source`
 *   returns the layer's current source; it is read when the layer starts.
 */
export function createSnapshotTimeline({
  id,
  clock,
  source,
  load,
  clear,
  resumeLive,
  now = () => globalThis.performance.now(),
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  let timeline = null;
  let releases = [];
  let started = false;
  // Whether the layer was away from live when it last heard of the clock.
  let wasActive = false;
  let lastJumps = null;
  let lastTimeMs = null;
  // Each request's number; an answer to an older one is dropped.
  let sequence = 0;
  let inflight = null;
  // The time of the newest snapshot applied since the last jump.
  let lead = null;
  // Cleared for a time outside coverage, so it is not cleared again.
  let empty = false;
  let waiting = null;
  let waitTimer = null;
  // Play waited its longest on the snapshot loading: it goes on without it.
  let capped = false;
  let gated;
  let failedUntil = -Infinity;
  let retryTimer = null;

  const span = () => {
    let covered;
    try {
      covered = timeline.coverage();
    } catch (error) {
      console.error(`Snapshot coverage failed: ${id}`, error);
      return null;
    }
    return covered &&
      Number.isFinite(covered.start) &&
      Number.isFinite(covered.end) &&
      covered.end >= covered.start
      ? covered
      : null;
  };
  const within = (timeMs, covered) =>
    timeMs >= covered.start && timeMs <= covered.end;
  const stepAtOrBefore = (timeMs) =>
    Math.floor(timeMs / timeline.stepMs) * timeline.stepMs;
  const playsOn = (state) => state.playing && !state.stepping;

  const setGate = (ms) => {
    if (ms === gated) return;
    gated = ms;
    clock.gate(id, ms);
  };
  const stopWaiting = () => {
    const release = waiting;
    waiting = null;
    if (waitTimer !== null) clearTimeout(waitTimer);
    waitTimer = null;
    release?.();
  };
  const startWaiting = () => {
    if (waiting || capped) return;
    waiting = clock.wait(id);
    waitTimer = setTimeout(() => {
      waitTimer = null;
      capped = true;
      stopWaiting();
      setGate(null);
    }, SNAPSHOT_WAIT_MS);
  };
  const stopRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  // Drop what loads; nothing that answers afterwards applies.
  const cancel = () => {
    sequence += 1;
    inflight?.controller.abort();
    inflight = null;
    capped = false;
    stopWaiting();
    stopRetry();
  };
  const clearOnce = () => {
    if (empty) return;
    empty = true;
    clear();
  };

  function request(atMs, replace) {
    // One load at a time: an older one is dropped before a newer starts.
    inflight?.controller.abort();
    const mine = ++sequence;
    const controller = new AbortController();
    inflight = { atMs, controller };
    const failed = () => {
      inflight = null;
      // A time that could not be shown shows nothing, not another time.
      if (replace) clearOnce();
      capped = false;
      stopWaiting();
      failedUntil = now() + SNAPSHOT_RETRY_MS;
      stopRetry();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (started) follow(clock.getState());
      }, SNAPSHOT_RETRY_MS);
    };
    // The source dropped this request for a newer one of its own: nothing
    // failed, so nothing is cleared or held back; the time is asked for again
    // as the clock next moves, or shortly.
    const superseded = () => {
      inflight = null;
      stopRetry();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (started) follow(clock.getState());
      }, SNAPSHOT_RETRY_MS);
    };
    Promise.resolve()
      .then(() => load(atMs, { signal: controller.signal, replace }))
      .then(
        (applied) => {
          if (mine !== sequence || controller.signal.aborted) return;
          if (applied === false) {
            failed();
            return;
          }
          inflight = null;
          lead = atMs;
          empty = false;
          capped = false;
          stopWaiting();
          follow(clock.getState());
        },
        (error) => {
          if (mine !== sequence || controller.signal.aborted) return;
          if (error?.name === 'AbortError') {
            superseded();
            return;
          }
          console.warn(`Snapshot at ${atMs} failed: ${id}`, error);
          failed();
        },
      );
  }

  // Show the time afresh: the snapshot at its step replaces every contact.
  function jumpTo(timeMs) {
    cancel();
    lead = null;
    setGate(null);
    const covered = span();
    if (!covered) return;
    if (!within(timeMs, covered)) {
      clearOnce();
      return;
    }
    startWaiting();
    request(Math.max(covered.start, stepAtOrBefore(timeMs)), true);
  }

  // The time moved on by itself, or nothing moved: load what it now needs.
  function keepUp(timeMs, state) {
    const covered = span();
    if (!covered) return;
    if (!within(timeMs, covered)) {
      cancel();
      lead = null;
      setGate(null);
      clearOnce();
      return;
    }
    if (inflight) {
      if (playsOn(state) && timeMs >= inflight.atMs) startWaiting();
      return;
    }
    if (now() < failedUntil) return;
    if (lead === null) {
      jumpTo(timeMs);
      return;
    }
    if (!playsOn(state)) {
      setGate(null);
      return;
    }
    const step = timeline.stepMs;
    if (lead - timeMs >= step) {
      setGate(lead);
      return;
    }
    const next = Math.min(
      covered.end,
      Math.max(lead + step, stepAtOrBefore(timeMs) + step),
    );
    if (next <= lead) {
      setGate(null);
      return;
    }
    setGate(capped ? null : next);
    request(next, false);
  }

  function follow(state) {
    if (!started) return;
    if (state.live) {
      lastJumps = state.jumps;
      lastTimeMs = null;
      if (!wasActive) return;
      wasActive = false;
      cancel();
      setGate(null);
      lead = null;
      empty = false;
      failedUntil = -Infinity;
      clear();
      resumeLive();
      return;
    }
    const timeMs = state.timeMs;
    const jumped =
      !wasActive ||
      state.jumps !== lastJumps ||
      (lastTimeMs !== null && timeMs < lastTimeMs);
    wasActive = true;
    lastJumps = state.jumps;
    lastTimeMs = timeMs;
    if (jumped) {
      failedUntil = -Infinity;
      jumpTo(timeMs);
    } else keepUp(timeMs, state);
  }

  /** Load the time shown afresh. */
  function reloadShown() {
    if (!started || clock.isLive()) return;
    failedUntil = -Infinity;
    jumpTo(clock.getState().timeMs);
  }

  return {
    /** The source's timeline while the layer follows the clock, else null. */
    get timeline() {
      return started ? timeline : null;
    },
    /** Whether the layer shows the snapshots this loads instead of polling. */
    active: () => started && !clock.isLive(),
    /** The layer is on: follow the clock if its source declares a timeline. */
    start() {
      if (started) return;
      timeline = readSnapshotTimeline(source());
      if (!timeline) return;
      started = true;
      wasActive = false;
      lastJumps = null;
      lastTimeMs = null;
      lead = null;
      empty = false;
      failedUntil = -Infinity;
      gated = undefined;
      releases = [
        clock.hold(id),
        clock.register({ id, coverage: () => span() }),
        clock.subscribe(follow),
      ];
      // A source tells of new coverage, or of a better answer for times it
      // has answered; paused, a time already shown is loaded again.
      const unsubscribe = timeline.subscribe?.(() => {
        clock.coverageChanged();
        if (!clock.isPlaying() && lead !== null && !inflight) reloadShown();
      });
      if (typeof unsubscribe === 'function') releases.push(unsubscribe);
      follow(clock.getState());
    },
    /** Load the time shown afresh, as when the area the layer asks for moved. */
    reload: () => reloadShown(),
    /** The layer is off: stop following and drop what loads. */
    stop() {
      if (!started) return;
      started = false;
      cancel();
      setGate(null);
      wasActive = false;
      lead = null;
      for (const release of releases.splice(0).reverse()) release();
      timeline = null;
    },
  };
}
