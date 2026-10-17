/**
 * A gate letting at most `limit` tasks run at once, first in first out, or
 * newest first with `lifo` (the last request is the one the user waits on).
 */
export function createLimiter(limit, { lifo = false } = {}) {
  let running = 0;
  const queue = [];
  function next() {
    while (running < limit && queue.length) {
      const item = lifo ? queue.pop() : queue.shift();
      const { task, resolve, reject, signal, onAbort } = item;
      if (onAbort) {
        signal?.removeEventListener?.('abort', onAbort);
      }
      if (signal?.aborted) {
        reject(signal.reason);
        continue;
      }
      running++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          running--;
          next();
        });
    }
  }
  return {
    run(task, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return new Promise((resolve, reject) => {
        const item = { task, resolve, reject, signal };
        const onAbort = () => {
          const at = queue.indexOf(item);
          if (at === -1) return;
          queue.splice(at, 1);
          reject(signal.reason);
        };
        item.onAbort = onAbort;
        queue.push(item);
        signal?.addEventListener('abort', onAbort, { once: true });
        next();
      });
    },
    get pending() {
      return running + queue.length;
    },
  };
}
