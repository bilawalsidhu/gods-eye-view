/** Queue timers instead of running them, so delayed work runs only on demand. */
export function installManualTimers(t) {
  const prior = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const timers = new Map();
  let timerId = 0;
  globalThis.setTimeout = (fn) => {
    timers.set(++timerId, fn);
    return timerId;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  t.after(() => Object.assign(globalThis, prior));
  return {
    timers,
    runAll() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
  };
}
