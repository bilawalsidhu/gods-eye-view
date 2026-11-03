// The page's scene host: the application is created once per page, and only
// the parts bound to a globe engine (its viewer, canvas, camera and frames)
// detach from the outgoing engine and attach to the incoming one.
//
// A part is `{ name, attachScene(scene, { signal, defer }), detachScene({ handoff }) }`.
// Parts attach in registration order and detach in reverse. `signal` belongs
// to one attachment: it aborts when that attachment detaches, so work a part
// started for one engine never lands on the next. `defer(cleanup)` registers
// a release that runs, in reverse, when the part detaches (before its
// detachScene).

const STATES = Object.freeze([
  'detached',
  'attaching',
  'attached',
  'detaching',
]);

export class SceneSwitchingError extends Error {
  constructor(message = 'The globe is switching engines') {
    super(message);
    this.name = 'SceneSwitchingError';
    this.code = 'ENGINE_SWITCHING';
  }
}

/**
 * @param {{onError?: (error: unknown, part: string) => void}} [options]
 */
export function createSceneHost({ onError = null } = {}) {
  const parts = [];
  const listeners = new Set();
  let state = 'detached';
  let scene = null;
  // The live attachment: its controller and each attached part's cleanups.
  let attachment = null;
  // The attach or detach under way, so a later call waits for it.
  let transition = Promise.resolve();

  function publish() {
    for (const listener of [...listeners]) {
      try {
        listener({ state, scene });
      } catch (error) {
        onError?.(error, 'listener');
      }
    }
  }

  async function attachPart(part, target, current) {
    const defers = [];
    const entry = { part, defers };
    current.attached.push(entry);
    await part.attachScene?.(target, {
      signal: current.controller.signal,
      defer(cleanup) {
        if (typeof cleanup !== 'function')
          throw new TypeError('A scene part defers a function');
        defers.push(cleanup);
      },
    });
    current.controller.signal.throwIfAborted();
  }

  async function detachEntry(entry, options, errors) {
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
      await entry.part.detachScene?.(options);
    } catch (error) {
      errors.push(error);
      onError?.(error, entry.part.name);
    }
  }

  async function release(current, options) {
    current.controller.abort();
    const errors = [];
    while (current.attached.length)
      await detachEntry(current.attached.pop(), options, errors);
    return errors;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function')
      throw new TypeError('Expected a scene listener');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function queue(work) {
    const run = transition.then(work, work);
    transition = run.catch(() => {});
    return run;
  }

  return Object.freeze({
    /**
     * Add a part. While a scene is attached the part attaches to it now, and
     * the returned promise settles with that attachment.
     */
    register(part) {
      if (!part || typeof part !== 'object' || typeof part.name !== 'string')
        throw new TypeError('A scene part needs a name');
      if (parts.includes(part)) return Promise.resolve();
      parts.push(part);
      if (state !== 'attached' || !attachment) return Promise.resolve();
      return attachPart(part, scene, attachment);
    },
    /** Attach every part to `target`, in order. A failure detaches the parts it attached. */
    attach(target) {
      if (!target) throw new TypeError('Attach needs a scene');
      return queue(async () => {
        if (state !== 'detached')
          throw new Error(`Cannot attach a scene while ${state}`);
        state = 'attaching';
        const current = { controller: new AbortController(), attached: [] };
        attachment = current;
        scene = target;
        publish();
        try {
          for (const part of [...parts])
            await attachPart(part, target, current);
        } catch (error) {
          const errors = await release(current, {
            handoff: false,
            failed: true,
          });
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
      });
    },
    /**
     * Detach every attached part, in reverse. Detaching nothing is a no-op;
     * a part that fails to detach does not stop the others.
     */
    detach(options = {}) {
      return queue(async () => {
        if (state === 'detached' || !attachment) return;
        const current = attachment;
        state = 'detaching';
        publish();
        let errors;
        try {
          errors = await release(current, options);
        } finally {
          attachment = null;
          scene = null;
          state = 'detached';
          publish();
        }
        if (errors.length)
          throw new AggregateError(errors, 'Scene parts could not detach');
      });
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
}

export const SCENE_HOST_STATES = STATES;
