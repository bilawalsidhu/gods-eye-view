import { setTimeout as sleepDefault } from 'node:timers/promises';

/** Admit at most 80 requests in a rolling minute; return retry seconds or zero.
 * Call only at the upstream boundary, after cache lookup and coalescing. */
export function createRainViewerGovernor() {
  const attempts = [];
  const queue = [];
  let timer;
  const delay = (now) => {
    while (attempts.length && now - attempts[0] >= 60_000) attempts.shift();
    return attempts.length >= 80 ? 60_000 - (now - attempts[0]) : 0;
  };
  const retry = (now) => Math.max(1, Math.ceil(delay(now) / 1000));
  const check = (now) => {
    if (delay(now) || queue.length) return retry(now);
    attempts.push(now);
    return 0;
  };
  function finish(waiter, value, error) {
    queue.splice(queue.indexOf(waiter), 1);
    waiter.signal?.removeEventListener('abort', waiter.abort);
    if (error) waiter.reject(error);
    else waiter.resolve(value);
  }
  function pump() {
    timer?.abort();
    timer = null;
    for (const waiter of [...queue]) {
      const time = waiter.now();
      if (time > waiter.deadline || delay(time) > waiter.deadline - time)
        finish(waiter, retry(time));
    }
    while (queue.length) {
      const waiter = queue[0];
      const time = waiter.now();
      const wait = delay(time);
      if (wait > waiter.deadline - time) {
        finish(waiter, retry(time));
        continue;
      }
      if (wait) {
        const controller = new AbortController();
        timer = controller;
        const duration = Math.min(
          wait,
          ...queue.map((entry) => entry.deadline - entry.now()),
        );
        Promise.resolve()
          .then(() =>
            waiter.sleep(duration, undefined, { signal: controller.signal }),
          )
          .then(
            () => {
              if (timer === controller) pump();
            },
            (error) => {
              if (timer !== controller) return;
              timer = null;
              for (const entry of [...queue]) finish(entry, undefined, error);
            },
          );
        return;
      }
      attempts.push(time);
      finish(waiter, 0);
    }
  }
  // Pass a clock function so each wake-up checks the current rolling window.
  check.admit = async (
    now = Date.now,
    { signal, maxWaitMs = 20_000, maxQueued = 256, sleep = sleepDefault } = {},
  ) => {
    signal?.throwIfAborted();
    const time = now();
    if (!queue.length && !delay(time)) {
      attempts.push(time);
      return 0;
    }
    if (queue.length >= maxQueued || delay(time) > maxWaitMs)
      return retry(time);
    return new Promise((resolve, reject) => {
      const waiter = {
        now,
        sleep,
        signal,
        deadline: time + maxWaitMs,
        resolve,
        reject,
      };
      waiter.abort = () => {
        finish(waiter, undefined, signal.reason);
        pump();
      };
      queue.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      pump();
    });
  };
  return check;
}
