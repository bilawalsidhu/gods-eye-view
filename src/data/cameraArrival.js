/**
 * Arrival corrections belong to one globe engine and yield to its next camera
 * owner.
 */
const arrivals = new WeakMap();

/** Cancel an outstanding arrival correction before navigation or teardown. */
export function cancelCameraArrival(engine) {
  if (engine) arrivals.get(engine)?.();
}

/** Register a correction and return an idempotent ownership release. */
export function ownCameraArrival(engine, cancel) {
  cancelCameraArrival(engine);
  arrivals.set(engine, cancel);
  return () => {
    if (arrivals.get(engine) === cancel) arrivals.delete(engine);
  };
}
