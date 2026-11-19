/**
 * Click-gesture classifiers for the tracking layers. The gesture itself
 * (summed travel and press time) is measured by the input dispatcher and
 * arrives on every click as `event.gesture` (src/input/dispatcher.js).
 */
export const MAX_TRACKING_CLICK_TRAVEL_PX = 6;
export const MAX_TRACKING_CLICK_DURATION_MS = 400;

/**
 * Decide whether a completed press stayed spatially click-like. Duration is
 * deliberately ignored so a stationary long press may still select a contact;
 * callers apply the full click classifier before destructive deselection.
 * @param {{travelPx?: number}} gesture - Accumulated pointer path.
 * @returns {boolean} True when travel stays within the click limit.
 */
export function isTrackingSelectionGesture(gesture = {}) {
  const travelPx = Number.isFinite(gesture.travelPx)
    ? Math.max(0, gesture.travelPx)
    : Number.POSITIVE_INFINITY;
  return travelPx <= MAX_TRACKING_CLICK_TRAVEL_PX;
}

/**
 * Decide whether a completed press is a clean click suitable for deselection
 * or another action that requires both short duration and low travel.
 * @param {{travelPx?: number, durationMs?: number}} gesture - Accumulated path and press time.
 * @returns {boolean} True when the gesture stays within both click limits.
 */
export function isTrackingClickGesture(gesture = {}) {
  const durationMs = Number.isFinite(gesture.durationMs)
    ? Math.max(0, gesture.durationMs)
    : Number.POSITIVE_INFINITY;
  return (
    isTrackingSelectionGesture(gesture) &&
    durationMs <= MAX_TRACKING_CLICK_DURATION_MS
  );
}
