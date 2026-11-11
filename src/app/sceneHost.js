import { ENGINE_CHOICES } from './engineChoice.js';

// The page's scene host: the application is created once per page, and only
// the parts bound to a globe engine (its viewer, canvas, camera and frames)
// detach from the outgoing engine and attach to the incoming one.
//
// A part is `{ name, attachScene(scene, { signal, defer, transaction }),
// detachScene({ handoff }, transaction) }`.
// Parts attach in registration order and detach in reverse. `signal` belongs
// to one attachment: it aborts when that attachment detaches, so work a part
// started for one engine never lands on the next. `defer(cleanup)` registers
// a release that runs, in reverse, when the part detaches (before its
// detachScene).

export class SceneSwitchingError extends Error {
  constructor(message = 'The globe is switching engines') {
    super(message);
    this.name = 'SceneSwitchingError';
    this.code = 'ENGINE_SWITCHING';
  }
}

/**
 * `transitionHost` shares the queue with a replacement application's fresh
 * parts. Transactions are valid only while their enclosing work runs.
 * @param {{onError?: (error: unknown, part: string) => void, transitionHost?: object}} [options]
 */
export function createSceneHost({
  onError = null,
  transitionHost = null,
} = {}) {
  const parts = [];
  const listeners = new Set();
  let state = 'detached';
  let scene = null;
  // The live attachment: its controller and each attached part's cleanups.
  let attachment = null;
  // The attach or detach under way, so a later call waits for it.
  let transition = Promise.resolve();
  const active = new Set();
  let scheduled = 0;

  function publish() {
    for (const listener of [...listeners]) {
      try {
        listener({ state, scene });
      } catch (error) {
        onError?.(error, 'listener');
      }
    }
  }

  async function attachPart(part, target, current, transaction) {
    const defers = [];
    const entry = { part, defers };
    current.attached.push(entry);
    await part.attachScene?.(target, {
      signal: current.controller.signal,
      transaction,
      defer(cleanup) {
        if (typeof cleanup !== 'function')
          throw new TypeError('A scene part defers a function');
        defers.push(cleanup);
      },
    });
    current.controller.signal.throwIfAborted();
  }

  async function detachEntry(entry, options, errors, transaction) {
    while (entry.defers.length) {
      const cleanup = entry.defers.pop();
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
        onError?.(error, entry.part.name);
      }
    }
    try {
      await entry.part.detachScene?.(options, transaction);
    } catch (error) {
      errors.push(error);
      onError?.(error, entry.part.name);
    }
  }

  async function release(current, options, transaction) {
    current.controller.abort();
    const errors = [];
    while (current.attached.length)
      await detachEntry(current.attached.pop(), options, errors, transaction);
    return errors;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function')
      throw new TypeError('Expected a scene listener');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Nested steps receive the current transaction explicitly. Unrelated calls
  // always wait, even while a part is awaiting attachment or release.
  function run(work, transaction, immediate = false) {
    if (transitionHost) return transitionHost.run(work, transaction, immediate);
    if (transaction && active.has(transaction)) return work(transaction);
    const execute = async () => {
      const current = Object.freeze({ host });
      active.add(current);
      try {
        return await work(current);
      } finally {
        active.delete(current);
        scheduled--;
      }
    };
    const idle = scheduled++ === 0;
    const previous = transition;
    let start;
    const result = new Promise((resolve, reject) => {
      start = () => execute().then(resolve, reject);
    });
    transition = result.catch(() => {});
    if (immediate && idle) start();
    else previous.then(start, start);
    return result;
  }

  const host = Object.freeze({
    run,
    createSwitcher: (options) =>
      createSceneRequests({
        ...options,
        run: (work) => run(work, null, true),
      }),
    /**
     * Add a part. While a scene is attached the part attaches to it now, and
     * the returned promise settles with that attachment.
     */
    register(part, transaction) {
      if (!part || typeof part !== 'object' || typeof part.name !== 'string')
        throw new TypeError('A scene part needs a name');
      if (parts.includes(part)) return Promise.resolve();
      parts.push(part);
      return run(async (transaction) => {
        if (state !== 'attached' || !attachment) return;
        if (attachment.attached.some((entry) => entry.part === part)) return;
        return attachPart(part, scene, attachment, transaction);
      }, transaction);
    },
    /** Attach every part to `target`, in order. A failure detaches the parts it attached. */
    attach(target, transaction) {
      if (!target) throw new TypeError('Attach needs a scene');
      return run(async (transaction) => {
        if (state !== 'detached')
          throw new Error(`Cannot attach a scene while ${state}`);
        state = 'attaching';
        const current = { controller: new AbortController(), attached: [] };
        attachment = current;
        scene = target;
        publish();
        try {
          for (const part of [...parts])
            await attachPart(part, target, current, transaction);
        } catch (error) {
          // The parts keep their own handoff choice; `failed` names why.
          const errors = await release(current, { failed: true }, transaction);
          attachment = null;
          scene = null;
          state = 'detached';
          publish();
          if (errors.length)
            throw new AggregateError(
              [error, ...errors],
              'A scene failed to attach and to release',
            );
          throw error;
        }
        state = 'attached';
        publish();
        return target;
      }, transaction);
    },
    /**
     * Detach every attached part, in reverse. Detaching nothing is a no-op;
     * a part that fails to detach does not stop the others.
     */
    detach(options = {}, transaction) {
      return run(async (transaction) => {
        if (state === 'detached' || !attachment) return;
        const current = attachment;
        state = 'detaching';
        publish();
        let errors;
        try {
          errors = await release(current, options, transaction);
        } finally {
          attachment = null;
          scene = null;
          state = 'detached';
          publish();
        }
        if (errors.length)
          throw new AggregateError(errors, 'Scene parts could not detach');
      }, transaction);
    },
    /** Release a retired application's part registry after its resources. */
    dispose(transaction) {
      return run(async (transaction) => {
        await host.detach({}, transaction);
        parts.length = 0;
        listeners.clear();
      }, transaction);
    },
    /** The attached scene, or null. */
    current: () => (state === 'attached' ? scene : null),
    state: () => state,
    parts: () => parts.map(({ name }) => name),
    subscribe,
    /**
     * The attached scene, now or once one attaches. Rejects with a
     * SceneSwitchingError when `signal` aborts or `timeoutMs` passes first.
     */
    whenAttached({ signal = null, timeoutMs = Infinity } = {}) {
      if (state === 'attached') return Promise.resolve(scene);
      return new Promise((resolve, reject) => {
        let timer = null;
        const finish = (error, value) => {
          clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(value);
        };
        const onAbort = () =>
          finish(
            new SceneSwitchingError('The wait for the globe was cancelled'),
          );
        const unsubscribe = subscribe(({ state: next, scene: value }) => {
          if (next === 'attached') finish(null, value);
        });
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (Number.isFinite(timeoutMs))
          timer = setTimeout(
            () => finish(new SceneSwitchingError()),
            Math.max(0, timeoutMs),
          );
      });
    },
  });
  return host;
}

/**
 * Drive engine switches for one page session.
 *
 * A failed attempt rolls back to the last engine that actually started
 * (never to the one that just failed) and, when that recovery fails too,
 * leaves the page without an engine but still able to take the next request. A page lifetime abort (pagehide) stops the
 * machine: nothing starts after it.
 *
 * @param {object} options
 * @param {string} options.kind The engine already running.
 * @param {() => string} options.requested The engine the address asks for now.
 * @param {AbortSignal} options.signal The page lifetime.
 * @param {(from: string, to: string, change: {visit: boolean}) => Promise<void>} options.leave
 *   Hand the session off from the running engine and release that engine.
 * @param {(kind: string, attempt: {recovery: boolean}) => Promise<void>} options.enter
 *   Start an engine on the retained session. It resolves once the engine runs
 *   with the session attached; when it rejects it has already released what
 *   it started.
 * @param {{select: (from: ?string) => *, commit: (token: *, kind: string) => void, restore: (kind: string) => void}} options.address
 * @param {(state: {failed: boolean}) => Promise<void>|void} [options.settle] Runs
 *   once the address is reconciled, before the machine reports idle.
 * @param {(kind: string) => void} [options.remember] Store a picked engine.
 * @param {(state: object) => void} [options.onChange]
 * @param {(error: unknown, outcome: {recovered: boolean, kind: ?string}) => void} [options.onFailure]
 */
function createSceneRequests({
  run,
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
  // The engine attached to the application or starting to attach: what a
  // history visit would leave.
  let live = kind;
  // The last engine that started successfully: the rollback target.
  let working = kind;
  let failed = false;
  let busy = false;
  // Every request (select or address visit) bumps this; a visit also bumps
  // `visits`.
  let requests = 0;
  let visits = 0;
  let queued = null;
  // The pick being started, held here rather than in the address: a visit
  // made meanwhile retires it and leaves every entry as it was.
  let pending = null;
  let running = null;

  const state = () =>
    Object.freeze({
      kind: current ?? working,
      engine: live,
      busy,
      failed,
    });
  const publish = () => onChange?.(state());

  function prepare(next) {
    pending = { to: next, token: address.select(current) };
  }

  /** The picker's choice. While a switch runs it is queued, not dropped. */
  function select(next) {
    if (!ENGINE_CHOICES.includes(next) || signal.aborted) return null;
    requests++;
    if (busy) {
      queued = next;
      return running;
    }
    if (next === current) return null;
    prepare(next);
    return start();
  }

  /** The address changed (history visit) or should be checked again. */
  function reconcile() {
    if (signal.aborted) return Promise.resolve();
    requests++;
    visits++;
    // A later visit supersedes a pick queued or starting before it.
    queued = null;
    pending = null;
    return busy ? running : start();
  }

  function start() {
    busy = true;
    publish();
    running = run(async (transaction) => {
      try {
        await drive(transaction);
      } catch (error) {
        onFailure?.(error, { recovered: current !== null, kind: current });
      } finally {
        busy = false;
        running = null;
        publish();
      }
    });
    return running;
  }

  async function drive(transaction) {
    for (;;) {
      await reconcileAddress(transaction);
      if (signal.aborted) return;
      const seen = requests;
      try {
        await settle?.({ failed }, transaction);
      } catch (error) {
        // Revealing the globe is cosmetic; the engine runs either way.
        console.error('The globe switch could not settle:', error);
      }
      if (signal.aborted || seen === requests) return;
    }
  }

  async function reconcileAddress(transaction) {
    let handled = null;
    for (;;) {
      if (signal.aborted) return;
      if (queued !== null) {
        const next = queued;
        queued = null;
        if (next !== current) prepare(next);
        else pending = null;
      }
      const target = pending?.to ?? requested();
      if (target === current) return;
      // After a failed recovery, wait for the person's next request instead
      // of retrying the same address in a loop.
      if (failed && handled === requests) return;
      handled = requests;
      await attempt(target, transaction);
    }
  }

  async function attempt(target, transaction) {
    const visitsAtStart = visits;
    const visit = pending?.to !== target;
    publish();
    try {
      if (current !== null) {
        const from = current;
        try {
          await leave(from, target, { visit }, transaction);
        } finally {
          current = null;
        }
      }
      if (signal.aborted) return;
      live = target;
      await enter(target, { recovery: false }, transaction);
      if (signal.aborted) return;
      current = working = target;
      failed = false;
      if (!visit && pending?.to === target) {
        address.commit(pending.token, target);
        remember?.(target);
      }
      pending = null;
    } catch (error) {
      if (signal.aborted) return;
      pending = null;
      // A failed pick never touched the address. A failed visit points its
      // entry at the working engine, unless the person has since moved on.
      if (visit && visits === visitsAtStart && requested() === target)
        address.restore(working);
      if (working === target) {
        live = null;
        failed = true;
        onFailure?.(error, { recovered: false, kind: null });
        return;
      }
      live = working;
      try {
        await enter(working, { recovery: true }, transaction);
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
