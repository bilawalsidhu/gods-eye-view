import { setTimeout as delay } from 'node:timers/promises';

// A four-request burst keeps a cold view responsive; thereafter every provider
// call shares the same one-per-second token supply. The rolling minute ceiling
// queues the few requests a token bucket alone could allow above 60/min.
const INAT_INTERVAL_MS = 1000;
const INAT_BURST = 4;
const INAT_WINDOW_MS = 60_000;
const INAT_MAX_PER_WINDOW = 60;
const INAT_MAX_IN_FLIGHT = 4;

/** Observation queries outrank tiles waiting for a token. Aborted consumers
 * leave the queue before an attempt or daily-budget reservation is spent. */
export function createInatQueue({
  now = () => performance.now(),
  wait = (ms) => delay(ms),
  intervalMs = INAT_INTERVAL_MS,
  burst = INAT_BURST,
  windowMs = INAT_WINDOW_MS,
  maxInFlight = INAT_MAX_IN_FLIGHT,
} = {}) {
  const pending = [];
  const dispatchedAt = [];
  let tokens = burst;
  let refilledAt = null;
  let running = false;
  let inFlight = 0;
  let slotFreed = null;

  function refill() {
    const at = now();
    if (refilledAt !== null && intervalMs > 0)
      tokens = Math.min(
        burst,
        tokens + Math.max(0, at - refilledAt) / intervalMs,
      );
    if (intervalMs <= 0) tokens = burst;
    refilledAt = at;
  }

  function schedule() {
    if (running) return;
    running = true;
    // A microtask also lets same-turn observation queries take priority.
    void Promise.resolve().then(drain);
  }

  async function drain() {
    try {
      while (pending.length) {
        if (inFlight >= maxInFlight) {
          await new Promise((resolve) => (slotFreed = resolve));
          continue;
        }
        refill();
        const at = now();
        while (dispatchedAt.length && dispatchedAt[0] <= at - windowMs)
          dispatchedAt.shift();
        const tokenWait = tokens < 1 ? (1 - tokens) * intervalMs : 0;
        const windowWait =
          windowMs > 0 && dispatchedAt.length >= INAT_MAX_PER_WINDOW
            ? dispatchedAt[0] + windowMs - at
            : 0;
        if (tokenWait > 0 || windowWait > 0) {
          await wait(Math.ceil(Math.max(tokenWait, windowWait)));
          continue;
        }
        // Stable sorting preserves FIFO order within each priority.
        pending.sort((a, b) => a.priority - b.priority);
        const job = pending.shift();
        job.signal?.removeEventListener('abort', job.abort);
        if (job.signal?.aborted) {
          job.reject(job.signal.reason);
          continue;
        }
        tokens -= 1;
        if (windowMs > 0) dispatchedAt.push(at);
        inFlight += 1;
        // A rejected task releases its slot without stopping the queue.
        void new Promise((resolve) => resolve(job.task()))
          .then(job.resolve, job.reject)
          .finally(() => {
            inFlight -= 1;
            const wake = slotFreed;
            slotFreed = null;
            wake?.();
          });
      }
    } finally {
      running = false;
    }
  }

  return function enqueue(task, { signal, priority = 1 } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const job = { task, signal, priority, resolve, reject };
      job.abort = () => {
        const index = pending.indexOf(job);
        if (index >= 0) pending.splice(index, 1);
        signal.removeEventListener('abort', job.abort);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      pending.push(job);
      schedule();
    });
  };
}
