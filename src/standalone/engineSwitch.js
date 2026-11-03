// The page's engine switch: one layer session, one engine at a time.
//
// The address (?engine=) is the source of truth. A switch from the picker
// (select) and a history visit (Back/Forward, a pasted address) are the same
// operation: the running engine hands the session off and is released, the
// requested engine starts on the retained session. Requests that arrive while
// a switch or a recovery runs are never dropped: once the current attempt
// settles, the address is read again and reconciled.

const ENGINES = Object.freeze(['cesium', 'navara']);

/** A started engine whose first frame takes longer than this is shown anyway. */
export const FIRST_FRAME_WAIT_MS = 10_000;

/**
 * Drive engine switches for one page session.
 *
 * Every attempt has a generation. A failed attempt rolls back to the last
 * engine that actually started (never to the one that just failed) and, when
 * that recovery fails too, leaves the page without an engine but still able
 * to take the next request. A page lifetime abort (pagehide) stops the
 * machine: nothing starts after it.
 *
 * @param {object} options
 * @param {string} options.kind The engine already running.
 * @param {() => string} options.requested The engine the address asks for now.
 * @param {AbortSignal} options.signal The page lifetime.
 * @param {(from: string, to: string) => Promise<void>} options.leave Hand the
 *   session off from the running engine and release that engine.
 * @param {(kind: string, attempt: {generation: number, recovery: boolean}) => Promise<void>} options.enter
 *   Start an engine on the retained session. It resolves once the engine runs
 *   with the session attached; when it rejects it has already released what
 *   it started.
 * @param {{select: (from: ?string, to: string) => *, commit: (token: *) => void, restore: (kind: string) => void}} options.address
 * @param {(state: {failed: boolean}) => Promise<void>|void} [options.settle] Runs
 *   once the address is reconciled, before the machine reports idle.
 * @param {(kind: string) => void} [options.remember] Store a picked engine.
 * @param {(state: object) => void} [options.onChange]
 * @param {(error: unknown, outcome: {recovered: boolean, kind: ?string}) => void} [options.onFailure]
 */
export function createEngineSwitch({
  kind,
  requested,
  signal,
  leave,
  enter,
  address,
  settle,
  remember,
  onChange,
  onFailure,
}) {
  // The engine whose session is live, null while none is.
  let current = kind;
  // The engine whose application exists or is starting: what a history visit
  // would leave.
  let live = kind;
  // The last engine that started successfully: the rollback target.
  let working = kind;
  let failed = false;
  let busy = false;
  let generation = 0;
  // Every request (select or address visit) bumps this; a visit also bumps
  // `visits`, which retires a select's pending history entry.
  let requests = 0;
  let visits = 0;
  let queued = null;
  let pending = null;
  let running = null;

  const state = () =>
    Object.freeze({
      kind: current ?? working,
      engine: live,
      busy,
      failed,
      generation,
    });
  const publish = () => onChange?.(state());

  function prepare(next) {
    pending = { to: next, visits, token: address.select(current, next) };
  }

  /** The picker's choice. While a switch runs it is queued, not dropped. */
  function select(next) {
    if (!ENGINES.includes(next) || signal.aborted) return null;
    requests++;
    if (busy) {
      queued = next;
      return running;
    }
    if (next === current) return null;
    prepare(next);
    return run();
  }

  /** The address changed (history visit) or should be checked again. */
  function reconcile() {
    if (signal.aborted) return Promise.resolve();
    requests++;
    visits++;
    // A later visit supersedes a select queued before it.
    queued = null;
    return busy ? running : run();
  }

  function run() {
    busy = true;
    publish();
    running = drive()
      .catch((error) => onFailure?.(error, { recovered: false, kind: null }))
      .finally(() => {
        busy = false;
        running = null;
        publish();
      });
    return running;
  }

  async function drive() {
    for (;;) {
      await reconcileAddress();
      if (signal.aborted) return;
      const seen = requests;
      await settle?.({ failed });
      if (signal.aborted || seen === requests) return;
    }
  }

  async function reconcileAddress() {
    let handled = null;
    for (;;) {
      if (signal.aborted) return;
      if (queued !== null) {
        const next = queued;
        queued = null;
        if (next !== current) prepare(next);
      }
      const target = requested();
      if (target === current) return;
      // After a failed recovery, wait for the person's next request instead
      // of retrying the same address in a loop.
      if (failed && handled === requests) return;
      handled = requests;
      await attempt(target);
    }
  }

  async function attempt(target) {
    const id = ++generation;
    const visitsAtStart = visits;
    publish();
    try {
      if (current !== null) {
        const from = current;
        try {
          await leave(from, target);
        } finally {
          current = null;
        }
      }
      if (signal.aborted) return;
      live = target;
      await enter(target, { generation: id, recovery: false });
      if (signal.aborted) return;
      current = working = target;
      failed = false;
      if (pending?.to === target && pending.visits === visits) {
        address.commit(pending.token);
        remember?.(target);
      }
      pending = null;
    } catch (error) {
      if (signal.aborted) return;
      pending = null;
      // Point this history entry back at the working engine unless the
      // person has since moved to another entry. Nothing is pushed, so a
      // failed switch leaves no extra entry behind.
      if (visits === visitsAtStart && requested() === target)
        address.restore(working);
      if (working === target) {
        live = null;
        failed = true;
        onFailure?.(error, { recovered: false, kind: null });
        return;
      }
      live = working;
      try {
        await enter(working, { generation: id, recovery: true });
        if (signal.aborted) return;
        current = working;
        failed = false;
        onFailure?.(error, { recovered: true, kind: working });
      } catch (recoveryError) {
        if (signal.aborted) return;
        live = null;
        failed = true;
        onFailure?.(recoveryError, { recovered: false, kind: null });
      }
    }
  }

  return Object.freeze({ select, reconcile, state });
}

/**
 * The engine choice in the page address. A picked engine replaces the
 * current entry while it starts; only a successful switch adds the history
 * entry (the earlier entry keeps the outgoing engine and view), so Back
 * returns to the previous engine and a failed switch adds nothing.
 */
export function createEngineAddress({ location, history, flush = () => {} }) {
  const withEngine = (engine) => {
    const url = new URL(location.href);
    url.searchParams.set('engine', engine);
    return url.href;
  };
  return Object.freeze({
    select(from, to) {
      flush();
      const previous = from ? withEngine(from) : null;
      history.replaceState(history.state, '', withEngine(to));
      return previous;
    },
    commit(previous) {
      if (!previous) return;
      const next = location.href;
      history.replaceState(history.state, '', previous);
      history.pushState(null, '', next);
    },
    restore(engine) {
      history.replaceState(history.state, '', withEngine(engine));
    },
  });
}

/**
 * Hand the session off before the running engine is released: record which
 * layers run so the next engine retains them, and park the cameras and the
 * Director scene instead of ending them. Every engine change in this page
 * hands off, whatever started it; the incoming engine reads the view
 * (camera, style, map) from the address it starts with, which for a history
 * visit may differ from the view that was showing.
 */
export function handOffSession(session) {
  const manager = session.manager;
  session.handoffLayers = new Map(
    [...manager.layers].map(([id, entry]) => [
      id,
      {
        entry: entry.module.attachRenderer ? entry : null,
        enabled: manager.isEffectivelyEnabled(id),
      },
    ]),
  );
  manager.layers.get('directions')?.module.suspendCamera?.();
  manager.layers.get('satellites')?.module.suspendCamera?.();
  session.director?.suspendScene();
}

/** Resume what handOffSession parked, once the incoming view is restored. */
export function resumeSession(session) {
  for (const { module } of session.manager.layers.values())
    module.resumeViewport?.();
  if (session.handoffLayers)
    session.manager.layers.get('directions')?.module.resumeCamera?.();
  session.director?.resumeScene();
}

/**
 * Wait for a started engine's first frame before the cover over it goes.
 *
 * A switch succeeds when the engine has started with the session attached;
 * this wait never fails it. It resolves true on the first drawn frame and
 * false when the tab is hidden (a hidden tab draws nothing and shows nothing,
 * so there is nothing to wait for) or after `timeoutMs` of visible time
 * without a frame, so a slow GPU leaves the new globe uncovered rather than
 * rolling a healthy engine back.
 */
export function waitForFirstFrame(
  engine,
  {
    document = globalThis.document,
    timeoutMs = FIRST_FRAME_WAIT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  if (document?.hidden) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timer = null;
    let remove = () => {};
    const finish = (drawn) => {
      remove();
      clearTimer(timer);
      document?.removeEventListener?.('visibilitychange', hidden);
      resolve(drawn);
    };
    function hidden() {
      if (document.hidden) finish(false);
    }
    remove = engine.frames.postRender.addEventListener(() => finish(true));
    timer = setTimer(() => finish(false), timeoutMs);
    document?.addEventListener?.('visibilitychange', hidden);
    engine.render.request('engine-switch');
  });
}
