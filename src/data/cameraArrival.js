/** Arrival corrections belong to one viewer and yield to its next camera owner. */
const arrivals = new WeakMap();

/** Cancel an outstanding arrival correction before navigation or teardown. */
export function cancelCameraArrival(viewer) {
  if (viewer) arrivals.get(viewer)?.();
}

/** Register a correction and return an idempotent ownership release. */
export function ownCameraArrival(viewer, cancel) {
  cancelCameraArrival(viewer);
  arrivals.set(viewer, cancel);
  return () => {
    if (arrivals.get(viewer) === cancel) arrivals.delete(viewer);
  };
}
