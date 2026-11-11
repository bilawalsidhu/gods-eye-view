/** Bound acquisition and body consumption, including transports that ignore abort. */
export async function requestWithDeadline(operation, { signal, timeoutMs }) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let rejectWait;
  const aborted = new Promise((_, reject) => {
    rejectWait = reject;
  });
  const rejectAbort = () => rejectWait(controller.signal.reason);
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort();
  }
}

/** Cancel one consumer's wait without cancelling a shared acquisition. */
export async function waitForSignal(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
