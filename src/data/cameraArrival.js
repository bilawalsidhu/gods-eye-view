import { engineFromViewer } from '../globe/cesium/engineFromViewer.js';

/**
 * Arrival corrections belong to one globe engine and yield to its next camera
 * owner. Callers may name the engine or (layers that still hold one) the
 * viewer it is registered for; both reach the same correction.
 */
const arrivals = new WeakMap();

const ownerOf = (engineOrViewer) =>
  engineFromViewer(engineOrViewer) ?? engineOrViewer;

/** Cancel an outstanding arrival correction before navigation or teardown. */
export function cancelCameraArrival(engineOrViewer) {
  if (engineOrViewer) arrivals.get(ownerOf(engineOrViewer))?.();
}

/** Register a correction and return an idempotent ownership release. */
export function ownCameraArrival(engineOrViewer, cancel) {
  const owner = ownerOf(engineOrViewer);
  cancelCameraArrival(owner);
  arrivals.set(owner, cancel);
  return () => {
    if (arrivals.get(owner) === cancel) arrivals.delete(owner);
  };
}
