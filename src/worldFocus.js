/**
 * One-click camera transfer for layer-owned world targets.
 */
import { WGS84, eastNorthUp, framePoint, toRadians } from './geo/index.js';
import { findCamera } from './render/rendererOf.js';
import {
  keptViewFrom,
  SELECTION_FOLLOW_TRANSITION_S,
} from './data/trackedCamera.js';

export const WORLD_FOCUS_REQUEST_EVENT = 'gev:world-request-focus';
export const WORLD_CLICK_FOCUS_DURATION_SEC = 1.9;

export const WORLD_FOCUS_FRAMING = Object.freeze({
  vessel: Object.freeze({ radiusM: 150, rangeM: 1200, pitchDeg: -30 }),
  fire: Object.freeze({ radiusM: 400, rangeM: 3000, pitchDeg: -35 }),
  sighting: Object.freeze({ radiusM: 250, rangeM: 2500, pitchDeg: -40 }),
  // A stopped train's one fly-to, and the frame a moving train is followed
  // in (src/layers/rail/follow.js): the train and the track either side.
  train: Object.freeze({ radiusM: 200, rangeM: 2500, pitchDeg: -35 }),
  'sighting-area': Object.freeze({
    radiusM: 11000,
    rangeM: 60000,
    pitchDeg: -55,
  }),
});

/** Validate a layer-owned focus target before camera policy can release tracking. */
export function isValidWorldFocusTarget(detail) {
  if (!detail || !WORLD_FOCUS_FRAMING[detail.kind]) return false;
  if (!String(detail.id || '').trim()) return false;
  const { position } = detail;
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  )
    return false;
  // These targets are surface-anchored Earth positions. Merely
  // finite coordinates near the ECEF origin cannot be flown to, and must be
  // rejected before the camera policy releases a current follow owner.
  const magnitude = Math.hypot(position.x, position.y, position.z);
  return Number.isFinite(magnitude) && magnitude >= WGS84.radii.z * 0.95;
}

/** Announce a valid user-click focus request. */
export function requestWorldFocus(detail, eventTarget = globalThis.window) {
  if (!isValidWorldFocusTarget(detail)) return false;
  if (typeof eventTarget?.dispatchEvent !== 'function') return false;
  eventTarget.dispatchEvent(
    new CustomEvent(WORLD_FOCUS_REQUEST_EVENT, { detail }),
  );
  return true;
}

/** Register one listener and return an idempotent disposer. */
export function registerWorldFocusRequestListener(eventTarget, listener) {
  if (
    !eventTarget?.addEventListener ||
    !eventTarget?.removeEventListener ||
    typeof listener !== 'function'
  )
    return () => {};
  eventTarget.addEventListener(WORLD_FOCUS_REQUEST_EVENT, listener);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    eventTarget.removeEventListener(WORLD_FOCUS_REQUEST_EVENT, listener);
  };
}

/** Route a valid request through the UI-owned camera policy. */
export function routeWorldFocusRequest(event, runExplicitFocus, fly) {
  const detail = event?.detail;
  if (!isValidWorldFocusTarget(detail)) return false;
  if (typeof runExplicitFocus !== 'function' || typeof fly !== 'function')
    return false;
  return runExplicitFocus(detail, () => fly(detail));
}

/**
 * Fly to a world target after ownership has been released. A target with
 * `keepView` (a click on it) keeps the camera's distance and angle: the eye
 * moves, on a straight path, to where it sees the target in the centre with
 * the view it has now (`keptViewFrom`). Any other is framed by its kind
 * (`WORLD_FOCUS_FRAMING`).
 */
export function flyToWorldTarget(viewer, target = {}) {
  const camera = findCamera(viewer);
  const framing = WORLD_FOCUS_FRAMING[target.kind];
  if (!camera || !framing || !isValidWorldFocusTarget(target)) return false;
  const pose = camera.pose();
  const kept = target.keepView ? keptViewFrom(pose, target.position) : null;
  camera.cancelFlight();
  if (kept) {
    camera.flyTo(framePoint(eastNorthUp(target.position), kept), {
      orientation: { direction: pose.direction, up: pose.up },
      durationS:
        target.durationSec > 0
          ? target.durationSec
          : SELECTION_FOLLOW_TRANSITION_S,
      easing: 'cubicInOut',
      // Below both ends: no arc, so the camera does not climb on the way.
      maxHeight: 0,
    });
    return true;
  }
  const heading = Number.isFinite(pose.heading) ? pose.heading : 0;
  const duration =
    target.durationSec > 0
      ? target.durationSec
      : WORLD_CLICK_FOCUS_DURATION_SEC;
  camera.flyToBounds(
    { center: target.position, radius: framing.radiusM },
    {
      offset: {
        heading,
        pitch: toRadians(framing.pitchDeg),
        range: framing.rangeM,
      },
      durationS: duration,
      easing: 'cubicInOut',
    },
  );
  return true;
}
