import { readSnapshotTimeline } from '../sources/live/contract.js';
import { fixesReachMs, TIMELINE_HELD_MS } from './timelineFixes.js';

/** The longest play waits on a snapshot before it goes on without it. */
export const SNAPSHOT_WAIT_MS = 8_000;
/** How long a snapshot that failed to load waits before it is asked again. */
export const SNAPSHOT_RETRY_MS = 5_000;
/**
 * How much play keeps of the loaded fixes after the newest snapshot: it holds
 * this far short of their end (at most half of them), so a contact never
 * reaches the end of its fixes while the next snapshot loads.
 */
export const SNAPSHOT_HOLD_MARGIN_MS = 60_000;
/**
 * How far ahead, in real time at the clock's rate, play asks for snapshots:
 * at a high rate it asks several steps before the time needs them.
 */
export const SNAPSHOT_PREFETCH_MS = 4_000;

/**
 * What a layer's `load` answers once it applied `snapshot`: `{ reachMs }`,
 * how far its records' fixes reach (fixesReachMs), when they carry fixes;
 * else true.
 * @param {{records?: Array<{fixes?: unknown}>}} snapshot
 * @returns {true|{reachMs: number}}
 */
export function snapshotAnswer(snapshot) {
  const reachMs = fixesReachMs(snapshot?.records);
  return reachMs === null ? true : { reachMs };
}

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
 * - When the source's timeline declares `spanMs`, its records carry their
 *   fixes from `spanMs` before a snapshot's time to `spanMs` after it, and
 *   the layer places each contact on them by the clock. Playing on, it asks
 *   for the next step SNAPSHOT_PREFETCH_MS of play ahead (at least a step),
 *   and play holds only SNAPSHOT_HOLD_MARGIN_MS short of the end of the
 *   newest snapshot's fixes, not at the step still loading. A seek or a move
 *   back that stays within the fixes the loaded snapshots carry is then no
 *   jump: nothing is cleared, play does not wait, and contacts move to the
 *   time smoothly. A move to a step before the newest loaded asks for that
 *   step once (`replace: true`): it brings back the contacts that left
 *   after it and drops those not there yet, while those it has keep their
 *   place, as their fixes put them. Paused, a time nearing the end of the
 *   fixes after the newest asks for the snapshot there (`replace: false`).
 * - Outside the source's coverage the layer is `clear()`ed and nothing loads;
 *   while the coverage is not known yet nothing loads and nothing is cleared.
 * - Back at live, `resumeLive()` polls at once and its snapshot takes the
 *   place of every contact: those it has move on from where they are drawn,
 *   and only those it lacks go. The contacts stay until it answers; when it
 *   answers anything but true (it could not be had), the layer is `clear()`ed.
 *   A rejection named AbortError (a newer poll took its place) clears nothing.
 *
 * `load` resolves true once the snapshot is applied, or `{ reachMs }` when its
 * records carry fixes, the newest of them (`fixesReachMs`), and false (or
 * rejects) when it could not be; it must not apply anything once `signal` aborts. A
 * rejection named AbortError is a request the source dropped for a newer
 * one: it is not a failure, and nothing is cleared.
 *
 * @param {{id: string, clock: ReturnType<typeof import('./worldClock.js').createWorldClock>,
 *   source: () => object|null,
 *   load: (atMs: number, options: {signal: AbortSignal, replace: boolean}) =>
 *     Promise<boolean|{reachMs: number}>,
 *   clear: () => void, resumeLive: () => boolean|Promise<boolean>,
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
  // The times of the newest and oldest snapshots applied since the last jump.
  let lead = null;
  let base = null;
  // The step a move back last asked for, until a newer snapshot applies.
  let scrubbed = null;
  // Cleared for a time outside coverage, so it is not cleared again.
  let empty = false;
  let waiting = null;
  let waitTimer = null;
  // Play waited its longest on the snapshot loading: it goes on without it.
  let capped = false;
  let gated;
  let failedUntil = -Infinity;
  let retryTimer = null;
  // Each return to live; an answer to an older one is dropped.
  let handovers = 0;
  // How far the fixes of each snapshot applied since the last jump reach.
  const reaches = new Map();

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

  // `quiet`: a move within the loaded fixes, which shows the contacts
  // already: play does not wait for it, and its failure clears nothing.
  function request(atMs, replace, quiet = false) {
    // One load at a time: an older one is dropped before a newer starts.
    inflight?.controller.abort();
    const mine = ++sequence;
    const controller = new AbortController();
    inflight = { atMs, controller, quiet };
    const failed = () => {
      inflight = null;
      // A time that could not be shown shows nothing, not another time.
      if (replace && !quiet) clearOnce();
      // Asked again once the retry is due.
      if (quiet) scrubbed = null;
      capped = false;
      stopWaiting();
      failedUntil = now() + SNAPSHOT_RETRY_MS;
      stopRetry();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        resume();
      }, SNAPSHOT_RETRY_MS);
    };
    // The source dropped this request for a newer one of its own: nothing
    // failed, so nothing is cleared or held back; the time is asked for again
    // as the clock next moves, or shortly.
    const superseded = () => {
      inflight = null;
      if (quiet) scrubbed = null;
      stopRetry();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        resume();
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
          held(atMs, replace, applied?.reachMs);
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

  // The snapshot at `atMs` is applied: the stretch of snapshot times loaded
  // (`base` to `lead`) takes it in. One the stretch does not reach with its
  // fixes (play went on without waiting, far past the newest) starts it
  // afresh: the contacts have no fixes for the time between. The stretch is
  // kept to TIMELINE_HELD_MS, from the end just loaded, which every
  // contact's fixes still cover.
  function held(atMs, replace, reachMs) {
    const reach = 2 * (timeline.spanMs || 0);
    scrubbed = null;
    const afresh =
      replace || lead === null || atMs > lead + reach || atMs < base - reach;
    if (afresh) reaches.clear();
    if (Number.isFinite(reachMs)) reaches.set(atMs, reachMs);
    else reaches.delete(atMs);
    if (afresh) {
      lead = atMs;
      base = atMs;
      return;
    }
    lead = Math.max(lead, atMs);
    base = Math.min(base, atMs);
    if (lead - base > TIMELINE_HELD_MS) {
      if (atMs === lead) base = lead - TIMELINE_HELD_MS;
      else lead = base + TIMELINE_HELD_MS;
    }
    for (const at of reaches.keys())
      if (at < base || at > lead) reaches.delete(at);
  }

  // Ask again for what the time needs, after a failure or a dropped load:
  // a time within the loaded fixes may still need a snapshot near their end.
  function resume() {
    if (!started) return;
    const state = clock.getState();
    if (!state.live && wasActive && heldAt(state.timeMs))
      scrubTo(state.timeMs, state);
    else follow(state);
  }

  // Whether the fixes of the snapshots loaded since the last jump span the
  // time, so contacts can be placed there without a jump.
  const heldAt = (timeMs) =>
    timeline.spanMs > 0 &&
    lead !== null &&
    base !== null &&
    timeMs >= base - timeline.spanMs &&
    timeMs <= lead + timeline.spanMs;

  // The clock moved to a time the loaded fixes span: contacts move there as
  // they are. A step before the newest loaded is asked for once, in place
  // of every contact; paused, a time in the outer half of the fixes after
  // the newest asks for the snapshot at its step, which brings those beyond.
  function scrubTo(timeMs, state) {
    const covered = span();
    if (!covered) return;
    if (!within(timeMs, covered)) {
      cancel();
      lead = null;
      base = null;
      setGate(null);
      clearOnce();
      return;
    }
    const half = timeline.spanMs / 2;
    const step = Math.max(covered.start, stepAtOrBefore(timeMs));
    if (step < lead) {
      if (step !== scrubbed && now() >= failedUntil) {
        scrubbed = step;
        if (inflight?.atMs !== step) request(step, true, true);
      }
      return;
    }
    if (!playsOn(state) && timeMs > lead + half && step > lead) {
      if (inflight?.atMs !== step && now() >= failedUntil) request(step, false);
      return;
    }
    keepUp(timeMs, state);
  }

  // Show the time afresh: the snapshot at its step replaces every contact.
  function jumpTo(timeMs) {
    cancel();
    lead = null;
    base = null;
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
      base = null;
      setGate(null);
      clearOnce();
      return;
    }
    const hold = lead === null ? null : holdAt(covered);
    if (inflight) {
      // With fixes past the newest snapshot, play waits only at their end.
      const waitsAt =
        timeline.spanMs > 0 && hold !== null ? hold : inflight.atMs;
      if (playsOn(state) && timeMs >= waitsAt && !inflight.quiet)
        startWaiting();
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
    if (lead - timeMs >= prefetchMs(state)) {
      setGate(hold);
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
    setGate(capped ? null : timeline.spanMs > 0 ? hold : next);
    // Past what the loaded fixes reach (play went on without waiting), the
    // contacts have no fixes for the time between: the step stands in for
    // them all.
    request(next, timeline.spanMs > 0 && next > lead + 2 * timeline.spanMs);
  }

  // Where play holds while the next snapshot loads: the newest loaded,
  // or, with fixes past it, SNAPSHOT_HOLD_MARGIN_MS short of where they
  // end: as far as that snapshot's fixes reach, at most the declared span
  // (never past the coverage).
  function holdAt(covered) {
    const reach = timeline.spanMs || 0;
    if (reach <= 0) return lead;
    const margin = Math.min(SNAPSHOT_HOLD_MARGIN_MS, reach / 2);
    const carried = reaches.get(lead);
    const end = Number.isFinite(carried)
      ? Math.min(lead + reach, carried)
      : lead + reach;
    return Math.max(lead, Math.min(covered.end, end - margin));
  }

  // How far ahead of the time play asks for the next step: a step, or with
  // fixes past each snapshot, SNAPSHOT_PREFETCH_MS of play at the clock's
  // rate, up to where play holds.
  function prefetchMs(state) {
    const step = timeline.stepMs;
    const reach = timeline.spanMs || 0;
    if (reach <= 0) return step;
    const rate = Number.isFinite(state.rate) ? Math.abs(state.rate) : 1;
    const margin = Math.min(SNAPSHOT_HOLD_MARGIN_MS, reach / 2);
    return Math.max(
      step,
      Math.min(reach - margin, rate * SNAPSHOT_PREFETCH_MS),
    );
  }

  // Back at live: the first live snapshot takes the place of every contact,
  // which stay drawn until it does; one that cannot be had clears them.
  function handOver() {
    const mine = ++handovers;
    const current = () => mine === handovers && started && clock.isLive();
    Promise.resolve()
      .then(() => resumeLive())
      .then(
        (applied) => {
          if (current() && applied !== true) clear();
        },
        (error) => {
          if (!current() || error?.name === 'AbortError') return;
          console.warn(`Live snapshot failed: ${id}`, error);
          clear();
        },
      );
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
      base = null;
      empty = false;
      failedUntil = -Infinity;
      handOver();
      return;
    }
    // Away from live, a return to it still answering no longer applies.
    handovers += 1;
    const timeMs = state.timeMs;
    // Away from live already: a move may stay within the loaded fixes.
    const wasFollowing = wasActive;
    const jumped =
      !wasActive ||
      state.jumps !== lastJumps ||
      (lastTimeMs !== null && timeMs < lastTimeMs);
    wasActive = true;
    lastJumps = state.jumps;
    lastTimeMs = timeMs;
    if (jumped && wasFollowing && heldAt(timeMs)) scrubTo(timeMs, state);
    else if (jumped) {
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
      base = null;
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
      handovers += 1;
      cancel();
      setGate(null);
      wasActive = false;
      lead = null;
      base = null;
      for (const release of releases.splice(0).reverse()) release();
      timeline = null;
    },
  };
}
