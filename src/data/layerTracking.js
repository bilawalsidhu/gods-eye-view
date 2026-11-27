/**
 * Tracking helpers the satellites, flights and military layers share.
 * @module data/layerTracking
 */

/** Dispatch a window event, a no-op where there is no window. */
export function emitWindowEvent(type, detail) {
  if (
    typeof window === 'undefined' ||
    !window.dispatchEvent ||
    typeof CustomEvent === 'undefined'
  )
    return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

/**
 * The pending tracking restore on a layer's state: `apply()` tracks the
 * pending subject once `canApply(pending)` holds and no newer tracking intent
 * came in, returning what `track(pending)` returns (false when not applied);
 * `cancel()` drops it and invalidates any restore already under way.
 * @param {{
 *   state: object,
 *   canApply: (pending: object) => boolean,
 *   track: (pending: object) => boolean,
 * }} options
 */
export function createTrackingRestore({ state, canApply, track }) {
  return {
    apply() {
      const pending = state._pendingTrackingRestore;
      if (
        !pending ||
        pending.generation !== state._trackingIntentGeneration ||
        !canApply(pending)
      )
        return false;
      state._pendingTrackingRestore = null;
      return track(pending);
    },
    cancel() {
      state._trackingIntentGeneration += 1;
      state._pendingTrackingRestore = null;
    },
  };
}
