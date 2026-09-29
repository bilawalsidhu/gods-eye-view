/**
 * Construct an instance-owned singleflight lane.
 *
 * Equivalent concurrent callers share one loader execution. A caller may stop
 * waiting without cancelling work still needed by another caller. The shared
 * loader is aborted only when its last waiter leaves.
 */
export function createSingleflight() {
  const inFlight = new Map();

  function waitFor(entry, signal) {
    signal?.throwIfAborted();
    const waiter = {};
    entry.waiters.add(waiter);

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', onAbort);
        entry.waiters.delete(waiter);
      };
      const onAbort = () => {
        if (settled) return;
        cleanup();
        if (entry.waiters.size === 0 && !entry.controller.signal.aborted) {
          entry.controller.abort(signal?.reason);
        }
        reject(signal?.reason);
      };

      signal?.addEventListener?.('abort', onAbort, { once: true });
      entry.promise.then(
        (value) => {
          if (settled) return;
          cleanup();
          resolve(value);
        },
        (error) => {
          if (settled) return;
          cleanup();
          reject(error);
        },
      );
    });
  }

  return {
    run(key, loader, { signal } = {}) {
      if (typeof loader !== 'function')
        throw new TypeError('Singleflight loader must be a function');
      signal?.throwIfAborted();

      let entry = inFlight.get(key);
      if (entry?.controller.signal.aborted) {
        if (inFlight.get(key) === entry) inFlight.delete(key);
        entry = null;
      }
      if (!entry) {
        const controller = new AbortController();
        entry = {
          controller,
          waiters: new Set(),
          promise: null,
        };
        entry.promise = Promise.resolve().then(() =>
          loader({ signal: controller.signal }),
        );
        inFlight.set(key, entry);
        entry.promise
          .finally(() => {
            if (inFlight.get(key) === entry) inFlight.delete(key);
          })
          .catch(() => {});
      }

      return waitFor(entry, signal);
    },

    getInFlightCount() {
      return inFlight.size;
    },
  };
}
