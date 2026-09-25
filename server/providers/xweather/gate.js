const fail = (code, status = 503) =>
  Object.assign(new Error(code), { code, status });

/**
 * Single-flight upstream work: one operation per key, at most `concurrency`
 * running, a bounded queue, a deadline each, and an abort only when the last
 * waiter leaves.
 *
 * A deliberate near-copy of `pump()`/`shared()` in `server/providers/weather.js`
 * with the same limits and semantics; the two can share one helper once both
 * providers settle.
 *
 * @param {object} [options]
 * @param {number} [options.concurrency] - Operations running at once.
 * @param {number} [options.queueLimit] - Operations waiting for a slot.
 * @param {number} [options.operationLimit] - Operations known at once.
 * @param {number} [options.timeoutMs] - Deadline per operation, from creation.
 * @returns {<T>(key: string, work: (signal: AbortSignal) => Promise<T>, clientSignal: AbortSignal) => Promise<T>}
 *   Rejects `xweather_busy` (status 429) when the queue is full.
 */
export function createUpstreamGate({
  concurrency = 8,
  queueLimit = 96,
  operationLimit = 120,
  timeoutMs = 12_000,
} = {}) {
  const operations = new Map();
  const pending = [];
  let active = 0;

  function pump() {
    while (active < concurrency && pending.length) {
      const operation = pending.shift();
      if (operation.controller.signal.aborted) continue;
      active++;
      Promise.resolve()
        .then(() => operation.work(operation.controller.signal))
        .then(operation.resolve, operation.reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  }
  return async function run(key, work, clientSignal) {
    clientSignal.throwIfAborted();
    let operation = operations.get(key);
    if (operation?.controller.signal.aborted) {
      operations.delete(key);
      operation = null;
    }
    if (!operation) {
      if (operations.size >= operationLimit || pending.length >= queueLimit)
        throw fail('xweather_busy', 429);
      const controller = new AbortController();
      operation = { controller, work, waiters: 0 };
      operation.promise = new Promise((resolve, reject) => {
        operation.resolve = resolve;
        operation.reject = reject;
      });
      const cancel = () => {
        const index = pending.indexOf(operation);
        if (index >= 0) pending.splice(index, 1);
        operation.reject(fail('xweather_request_cancelled'));
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      operation.promise = operation.promise.finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', cancel);
        if (operations.get(key) === operation) operations.delete(key);
      });
      operations.set(key, operation);
      pending.push(operation);
      pump();
    }
    operation.waiters++;
    const leave = () => {
      if (--operation.waiters === 0) operation.controller.abort();
    };
    clientSignal.addEventListener('abort', leave, { once: true });
    try {
      const value = await operation.promise;
      clientSignal.throwIfAborted();
      return value;
    } finally {
      clientSignal.removeEventListener('abort', leave);
      if (!clientSignal.aborted) operation.waiters--;
    }
  };
}
