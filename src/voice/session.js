/**
 * Protocol-independent voice lifetime and action dispatch.
 * An adapter receives { emit, runAction, signal } and supplies start, stop,
 * sendText and sendMapEvent. It owns its microphone/connection and wire messages.
 * Events: state, transcript, action-call, progress, action-result, interruption,
 * completion, turn-metrics.
 */
export function createVoiceSession({ createAdapter, runner, signal }) {
  if (typeof createAdapter !== 'function' || typeof runner !== 'function')
    throw new TypeError('Voice requires an adapter factory and action runner');
  const lifetime = new AbortController();
  const listeners = new Set();
  const actions = new Set();
  let adapter;
  let state = 'idle';
  let disposed = false;
  let generation = 0;
  let startAttempt = 0;

  function cancelActions() {
    generation++;
    for (const action of actions) action.abort();
    actions.clear();
  }

  function emit(event) {
    if (disposed || !event || typeof event.type !== 'string') return;
    if (event.type === 'disposed') {
      dispose(false);
      return;
    }
    if (event.type === 'state') {
      state = event.state;
      if (['idle', 'error', 'connecting'].includes(state)) cancelActions();
    }
    if (event.type === 'interruption') cancelActions();
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* Observers cannot break a session. */
      }
    }
  }

  async function runAction(name, args, options = {}) {
    if (
      disposed ||
      lifetime.signal.aborted ||
      ['idle', 'error'].includes(state)
    )
      throw abortError();
    const action = new AbortController();
    const epoch = generation;
    actions.add(action);
    const actionSignal = AbortSignal.any([
      lifetime.signal,
      action.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    const isCurrent = () =>
      !actionSignal.aborted &&
      epoch === generation &&
      (!options.isCurrent || options.isCurrent());
    const callId = options.callId ?? null;
    try {
      if (!isCurrent()) throw abortError();
      // Calls carry the adapter's call id so observers can match progress
      // and results to the right call when a tool runs twice at once.
      emit({ type: 'action-call', name, callId, arguments: args });
      if (!isCurrent()) throw abortError();
      // Step reports reach observers only while the action is current, so a
      // cancelled tool cannot update the plan or start narration.
      const progress = (update) => {
        if (!isCurrent() || !update?.step) return;
        emit({
          type: 'progress',
          name,
          callId,
          step: update.step,
          label: update.label,
        });
        options.progress?.(update);
      };
      const result = await runner(name, args, {
        ...options,
        signal: actionSignal,
        isCurrent,
        progress,
      });
      if (!isCurrent()) throw abortError();
      emit({ type: 'action-result', name, callId, result });
      return result;
    } catch (error) {
      if (isCurrent())
        emit({
          type: 'action-result',
          name,
          callId,
          result: { ok: false, error: error?.message || String(error) },
        });
      throw error;
    } finally {
      actions.delete(action);
    }
  }

  function dispose(stopAdapter = true) {
    if (disposed) return;
    disposed = true;
    startAttempt++;
    state = 'idle';
    cancelActions();
    lifetime.abort();
    signal?.removeEventListener('abort', abort);
    listeners.clear();
    if (stopAdapter) adapter?.stop({ removeUi: true });
  }
  const abort = () => dispose();
  try {
    adapter = createAdapter({ emit, runAction, signal: lifetime.signal });
    for (const method of ['start', 'stop', 'sendText', 'sendMapEvent']) {
      if (typeof adapter?.[method] !== 'function')
        throw new TypeError('Voice adapter must implement ' + method);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) dispose();

  return {
    adapter,
    signal: lifetime.signal,
    get state() {
      return state;
    },
    get disposed() {
      return disposed;
    },
    isActive: () => !disposed && !['idle', 'error'].includes(state),
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(options) {
      if (disposed || !['idle', 'error'].includes(state)) return;
      emit({ type: 'state', state: 'connecting' });
      const attempt = ++startAttempt;
      try {
        await adapter.start(options);
      } catch (error) {
        if (!disposed && attempt === startAttempt) {
          try {
            adapter.stop({ preserveStatus: true });
          } finally {
            emit({ type: 'state', state: 'error', detail: error.message });
          }
        }
      }
    },
    stop(options = {}) {
      if (options.removeUi) return dispose();
      if (disposed) return;
      startAttempt++;
      cancelActions();
      try {
        adapter.stop(options);
      } finally {
        if (!options.preserveStatus)
          emit({ type: 'state', state: 'idle', detail: 'Voice off' });
      }
    },
    sendText: (text) => !disposed && adapter.sendText(text),
    sendMapEvent: (event) => !disposed && adapter.sendMapEvent(event),
    destroy: () => dispose(),
  };
}

function abortError() {
  return new DOMException('Voice action cancelled', 'AbortError');
}
