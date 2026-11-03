// The voice action runner for a page whose globe engine can change while a
// voice session runs. The session keeps one runner; each engine attachment
// builds the runner of that scene (createGevActionRunner over its viewer,
// engine, shell and annotations) and the forwarder sends every call to the
// current one. A call made while the engines switch waits for the next
// attachment, up to a bound, and then runs on the engine that attached; when
// none attaches in time it is refused with ENGINE_SWITCHING.

/** How long a call waits for the next engine before it is refused. */
export const ENGINE_SWITCH_WAIT_MS = 15_000;

/** The refusal for a call that found no engine within the wait. */
export function engineSwitchingRefusal(name) {
  return {
    ok: false,
    action: name,
    applied: false,
    code: 'ENGINE_SWITCHING',
    error: 'The globe is switching engines; this action was not run.',
    say: 'The globe is switching engines. Ask again in a moment.',
  };
}

/**
 * @param {object} options
 * @param {(scene: object) => Function} options.build The runner for one
 *   attached scene; its optional `dispose()` runs when the scene detaches.
 * @param {() => boolean} [options.isSwitching] True while the page switches
 *   engines, even before the outgoing scene has detached.
 * @param {number} [options.switchWaitMs]
 */
export function createSceneRunner({
  build,
  isSwitching = () => false,
  switchWaitMs = ENGINE_SWITCH_WAIT_MS,
}) {
  if (typeof build !== 'function')
    throw new TypeError('A scene runner needs a build function');
  let inner = null;
  let kind = null;
  let attachment = null;
  // Bumped by every attachment, so a waiting call knows one happened.
  let attachments = 0;
  let conversation = 0;
  let disposed = false;
  const waiters = new Set();

  const wake = () => {
    for (const resolve of [...waiters]) resolve();
    waiters.clear();
  };

  // Resolves true once a scene is ready (one attached since the wait began,
  // or the switch settled with a scene), false when the wait is cut short.
  async function waitForScene(signal, timeoutMs) {
    const since = attachments;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (disposed || signal?.aborted) return false;
      if (inner && (attachments !== since || !isSwitching())) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolve) => {
        let timer = null;
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          waiters.delete(done);
          resolve();
        };
        waiters.add(done);
        signal?.addEventListener('abort', done, { once: true });
        timer = setTimeout(done, remaining);
      });
    }
  }

  async function run(name, args, options = {}) {
    if (disposed)
      return {
        ok: false,
        action: name,
        cancelled: true,
        error: 'Voice ended.',
      };
    if (!inner || isSwitching()) {
      const found = await waitForScene(options.signal, run.switchWaitMs);
      if (disposed)
        return {
          ok: false,
          action: name,
          cancelled: true,
          error: 'Voice ended.',
        };
      if (!found) return engineSwitchingRefusal(name);
    }
    const current = inner;
    const currentKind = kind;
    const epoch = conversation;
    const signal = options.signal
      ? AbortSignal.any([options.signal, attachment.signal])
      : attachment.signal;
    const result = await current(name, args, {
      ...options,
      signal,
      isCurrent: () =>
        epoch === conversation &&
        !disposed &&
        current === inner &&
        (typeof options.isCurrent !== 'function' || options.isCurrent()),
    });
    // Say which engine answered: after a switch the model reads the result
    // of the globe the person now sees.
    return result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      result.engine === undefined
      ? { ...result, engine: currentKind }
      : result;
  }

  run.switchWaitMs = switchWaitMs;
  /** The engine kind of the attached scene, or null. */
  run.engineKind = () => kind;
  /** Build the runner for `scene`; waiting calls run on it. */
  run.attach = (scene) => {
    if (disposed) return;
    run.detach();
    attachment = new AbortController();
    inner = build(scene);
    kind = scene?.engine?.kind ?? (scene?.viewer ? 'cesium' : null);
    attachments++;
    wake();
  };
  /** Stop the attached runner: its calls in flight see their signal abort. */
  run.detach = () => {
    attachment?.abort();
    attachment = null;
    const previous = inner;
    inner = null;
    kind = null;
    // The conversation (the analyst's last answer) continues on the next
    // engine: only this runner ends.
    previous?.dispose?.({ keepMemory: true });
  };
  /** The page's switch settled: waiting calls look again. */
  run.wake = wake;
  run.resetConversation = () => {
    conversation++;
    inner?.resetConversation?.();
  };
  run.dispose = () => {
    if (disposed) return;
    run.resetConversation();
    disposed = true;
    run.detach();
    wake();
  };
  return run;
}
