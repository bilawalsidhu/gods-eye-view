// Only a first-party input boundary can mint these records. Tool arguments,
// generated viewport messages and assistant text are never input provenance.
const records = new WeakMap();

function notifyVoiceUserTurn(record, { retire = false } = {}) {
  if (!record) return;
  for (const listener of [...record.listeners]) {
    if (!record.listeners.has(listener)) continue;
    try {
      listener(record.token);
    } catch {
      // An observer cannot prevent canonical input updates or revocation.
    }
  }
  if (retire) record.listeners.clear();
}

/** Observe current input changes; subscription itself grants no authority. */
export function subscribeVoiceUserTurn(token, listener) {
  const record = token && typeof token === 'object' ? records.get(token) : null;
  if (!record?.isCurrent() || typeof listener !== 'function') return () => {};
  const observer = (value) => listener(value);
  record.listeners.add(observer);
  try {
    listener(token);
  } catch {
    // Initial inspection has the same isolation as subsequent notifications.
  }
  return () => record.listeners.delete(observer);
}

export function createVoiceUserTurnTracker({
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  keyedRequests = false,
} = {}) {
  let current = null;
  const responses = new Map();
  const inputs = new Map();
  const pending = [];
  const waiters = new Set();
  let overflow = false;
  let resetGeneration = 0;
  const retireCurrent = () => {
    const previous = current;
    current = null;
    notifyVoiceUserTurn(previous, { retire: true });
  };
  const responseState = (id) => {
    const record = responses.get(id);
    if (!record) return { status: 'untracked', userTurn: undefined };
    if (record !== current) return { status: 'stale', userTurn: undefined };
    if (record.transcriptionStatus === 'pending')
      return { status: 'pending-speech', userTurn: undefined };
    if (
      !record.text &&
      !['failed', 'disabled'].includes(record.transcriptionStatus)
    )
      return { status: 'unresolved', userTurn: undefined };
    return { status: 'ready', userTurn: record.token };
  };
  const settleWaiter = (waiter, value) => {
    if (!waiters.delete(waiter)) return;
    clearTimer(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    waiter.resolve(value);
  };
  const settleWaiters = (forced = null) => {
    for (const waiter of [...waiters]) {
      const value = forced || responseState(waiter.id);
      if (value.status !== 'pending-speech') settleWaiter(waiter, value);
    }
  };
  const reset = () => {
    resetGeneration++;
    settleWaiters({ status: 'stale', userTurn: undefined });
    const previous = current;
    current = null;
    responses.clear();
    inputs.clear();
    pending.length = 0;
    overflow = false;
    notifyVoiceUserTurn(previous, { retire: true });
  };
  const begin = (
    itemId,
    text,
    inputKind,
    transcriptionStatus = 'completed',
  ) => {
    // Keep pending response reservations for older turns. Their delayed
    // response.created must consume their own slot, never the newer input.
    settleWaiters({ status: 'stale', userTurn: undefined });
    const previous = current;
    responses.clear();
    const token = Object.freeze({});
    const record = {
      itemId,
      text,
      inputKind,
      transcriptionStatus,
      token,
      listeners: new Set(),
      isCurrent: () => current === record,
    };
    records.set(token, record);
    current = record;
    if (itemId) {
      inputs.set(itemId, record);
      while (inputs.size > 16) inputs.delete(inputs.keys().next().value);
    }
    notifyVoiceUserTurn(previous, { retire: true });
    return current === record ? token : undefined;
  };
  const reserve = (record, requestId = null) => {
    if (overflow) return;
    pending.push({ record, requestId });
    if (pending.length > 16) {
      settleWaiters({ status: 'stale', userTurn: undefined });
      retireCurrent();
      pending.length = 0;
      overflow = true;
    }
  };
  return {
    reservationState() {
      return Object.freeze({ pending: pending.length, overflowed: overflow });
    },
    invalidate() {
      settleWaiters({ status: 'stale', userTurn: undefined });
      responses.clear();
      retireCurrent();
    },
    rejectPendingResponse(requestId) {
      if (!requestId) return false;
      const index = pending.findIndex((slot) => slot.requestId === requestId);
      if (index < 0) return false;
      const [{ record }] = pending.splice(index, 1);
      if (record === current) {
        responses.clear();
        retireCurrent();
      }
      return true;
    },
    text(text) {
      return begin(null, typeof text === 'string' ? text.trim() : '', 'typed');
    },
    // Provider adapters own duplicate/input admission before this transition.
    speechStarted(
      itemId,
      { transcriptionEnabled = true, isCurrent = () => true } = {},
    ) {
      const generation = resetGeneration;
      settleWaiters({ status: 'stale', userTurn: undefined });
      retireCurrent();
      // A synchronous token observer may Stop/replace the session. That reset
      // owns the new lifetime. An observer can also submit newer typed input;
      // this old onset must not overwrite either successor after notification.
      if (resetGeneration !== generation || !isCurrent()) return;
      responses.clear();
      if (typeof itemId === 'string' && itemId)
        begin(
          itemId,
          null,
          'speech',
          transcriptionEnabled ? 'pending' : 'disabled',
        );
    },
    transcript(itemId, text) {
      if (!current || !itemId || current.itemId !== itemId) return false;
      // A final transcript belongs to exactly one live microphone item.
      if (current.transcriptionStatus !== 'pending' || typeof text !== 'string')
        return false;
      current.text = text.trim();
      current.transcriptionStatus = current.text ? 'completed' : 'empty';
      settleWaiters();
      notifyVoiceUserTurn(current);
      return true;
    },
    appendSpeechSegment(itemId, text) {
      if (
        !current ||
        !itemId ||
        current.itemId !== itemId ||
        current.inputKind !== 'speech' ||
        !['pending', 'completed'].includes(current.transcriptionStatus) ||
        typeof text !== 'string' ||
        !text.trim()
      )
        return false;
      // Gemini supplies finalized segments, rather than OpenAI's one final
      // item transcript. Keep the input identity and extend its canonical text.
      current.text = [current.text, text.trim()].filter(Boolean).join(' ');
      current.transcriptionStatus = 'completed';
      settleWaiters();
      notifyVoiceUserTurn(current);
      return true;
    },
    transcriptionUnavailable(itemId, reason) {
      if (
        reason !== 'failed' ||
        !current ||
        !itemId ||
        current.itemId !== itemId ||
        current.inputKind !== 'speech' ||
        current.transcriptionStatus !== 'pending'
      )
        return false;
      current.transcriptionStatus = reason;
      settleWaiters();
      notifyVoiceUserTurn(current);
      return true;
    },
    rememberSupersededSpeech(itemId) {
      // An admitted onset can lose to newer local input during notification,
      // before it becomes current. Its later real commit still needs a stale
      // identity, but remembering it grants no token or response reservation.
      if (typeof itemId !== 'string' || !itemId || inputs.has(itemId)) return;
      inputs.set(itemId, { itemId, committed: false });
      while (inputs.size > 16) inputs.delete(inputs.keys().next().value);
    },
    commitSpeech(itemId) {
      // A provider input-buffer commit causes one automatic VAD response.
      const record = inputs.get(itemId);
      if (record?.committed) return;
      if (record) record.committed = true;
      reserve(record || null);
    },
    captureRequest(responseId = undefined) {
      const record =
        responseId === undefined ? current : responses.get(responseId) || null;
      const generation = resetGeneration;
      let reserved = false;
      return Object.freeze({
        isCurrent: () => generation === resetGeneration && record === current,
        reserve(requestId) {
          if (reserved || generation !== resetGeneration) return false;
          reserved = true;
          // Capture before transport callbacks, reserve only after send. A
          // newer input makes this original record stale, never its successor.
          reserve(record, requestId);
          return true;
        },
      });
    },
    expectResponse(requestId = null) {
      // Called only when the application sends a typed/tool-follow-up response
      // request; generated out-of-band progress responses do not reserve one.
      reserve(current, requestId);
    },
    bindResponse(id, requestId = null) {
      if (!id || overflow) return null;
      if (keyedRequests && responses.has(id))
        return responses.get(id) === current ? 'current' : 'stale';
      let index = 0;
      if (keyedRequests) {
        // Only server-returned client metadata can select a client request.
        // Untagged automatic responses cannot borrow typed/follow-up slots.
        if (requestId !== null && (typeof requestId !== 'string' || !requestId))
          return 'stale';
        index = pending.findIndex((slot) => slot.requestId === requestId);
        if (index < 0) return requestId === null ? 'untracked' : 'stale';
      }
      const record = pending.splice(index, 1)[0]?.record;
      if (!record) return 'untracked';
      if (record !== current) return 'stale';
      responses.set(id, record);
      while (responses.size > 16)
        responses.delete(responses.keys().next().value);
      return 'current';
    },
    waitForResponse(id, { signal, timeoutMs = 5000 } = {}) {
      const state = responseState(id);
      if (state.status !== 'pending-speech') return Promise.resolve(state);
      if (signal?.aborted)
        return Promise.resolve({ status: 'stale', userTurn: undefined });
      return new Promise((resolve) => {
        const waiter = {
          id,
          resolve,
          signal,
          timer: null,
          abort: null,
        };
        waiter.abort = () =>
          settleWaiter(waiter, { status: 'stale', userTurn: undefined });
        waiter.timer = setTimer(
          () =>
            settleWaiter(waiter, {
              status: 'unresolved',
              userTurn: undefined,
            }),
          Math.max(1, Math.min(10_000, Number(timeoutMs) || 5000)),
        );
        signal?.addEventListener('abort', waiter.abort, { once: true });
        waiters.add(waiter);
      });
    },
    forResponse(id) {
      return responseState(id).userTurn;
    },
    completeResponse(id, hasToolCalls = false) {
      const record = responses.get(id);
      if (hasToolCalls) return;
      responses.delete(id);
      // A function-call response can continue after its tool result. A final
      // answer retires the request, so later automatic turns cannot reuse it.
      if (record && record === current && !hasToolCalls) {
        responses.clear();
        retireCurrent();
      }
    },
    reset,
  };
}

/** Read original text only from an authentic, still-current input token. */
export function readVoiceUserTurnText(token) {
  const record = token && typeof token === 'object' ? records.get(token) : null;
  return record?.isCurrent() && record.text ? record.text : undefined;
}

/** Read the first-party input boundary that minted a current turn token. */
export function readVoiceUserTurnInputKind(token) {
  const record = token && typeof token === 'object' ? records.get(token) : null;
  return record?.isCurrent() ? record.inputKind : undefined;
}

/** Read authentic input state without treating missing captions as user text. */
export function readVoiceUserTurnProvenance(token) {
  const record = token && typeof token === 'object' ? records.get(token) : null;
  return record?.isCurrent()
    ? {
        inputKind: record.inputKind,
        transcriptionStatus: record.transcriptionStatus,
      }
    : undefined;
}
