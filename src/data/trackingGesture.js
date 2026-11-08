import { isPointerFree } from './inputOwnership.js';

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

/** Accumulate press travel and duration, consuming the result on click. */
export function createPressGesture(now = () => performance.now()) {
  let press = null;
  let completed = null;
  const travel = (position) => {
    if (
      !press ||
      !Number.isFinite(position?.x) ||
      !Number.isFinite(position?.y)
    )
      return;
    if (press.last)
      press.travelPx += Math.hypot(
        position.x - press.last.x,
        position.y - press.last.y,
      );
    press.last = { x: position.x, y: position.y };
  };
  const finish = (position) => {
    if (!press) return;
    travel(position);
    completed = {
      travelPx: press.travelPx,
      durationMs: Math.max(0, now() - press.startedAt),
    };
    press = null;
  };
  return {
    down(position) {
      press = { startedAt: now(), travelPx: 0, last: null };
      completed = null;
      travel(position);
    },
    move: travel,
    up: finish,
    click(position) {
      finish(position);
      const gesture = completed ?? { travelPx: 0, durationMs: 0 };
      completed = null;
      return gesture;
    },
  };
}

/** Bind engine input with press metadata; the caller chooses its click rule. */
export function bindTrackingClickGesture(
  input,
  onClick,
  { now, onMouseMove } = {},
) {
  const press = createPressGesture(now);
  const removes = [
    input.on('down', (event) => press.down(event?.position)),
    input.on('move', (event) => {
      press.move(event?.endPosition ?? event?.position);
      onMouseMove?.(event);
    }),
    input.on('up', (event) => press.up(event?.position)),
    input.on('click', (click) => {
      const gesture = press.click(click?.position);
      if (!isPointerFree()) return;
      onClick(click, gesture);
    }),
  ];
  return () => removes.forEach((remove) => remove());
}
