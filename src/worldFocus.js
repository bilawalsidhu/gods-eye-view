/**
 * One-click camera transfer for layer-owned world targets.
 */
import { WGS84, toRadians } from './geo/index.js';
import { findCamera } from './render/rendererOf.js';
import { flyKeepingView } from './data/clickSelect.js';

export const WORLD_FOCUS_REQUEST_EVENT = 'gev:world-request-focus';
export const WORLD_CLICK_FOCUS_DURATION_SEC = 1.9;

export const WORLD_FOCUS_FRAMING = Object.freeze({
  vessel: Object.freeze({ radiusM: 150, rangeM: 1200, pitchDeg: -30 }),
  fire: Object.freeze({ radiusM: 400, rangeM: 3000, pitchDeg: -35 }),
  sighting: Object.freeze({ radiusM: 250, rangeM: 2500, pitchDeg: -40 }),
  // A train's focus (src/layers/rail/focus.js): the train and the track
  // either side, for a request that does not keep the view.
  train: Object.freeze({ radiusM: 200, rangeM: 2500, pitchDeg: -35 }),
  // A clicked quake's magnitude label: its disc (2^M km in radius, so about
  // 6 km at M2.5 and 64 km at M6) and the ground around it. A larger quake
  // passes its own radius and range (never less than these).
  earthquake: Object.freeze({ radiusM: 20000, rangeM: 220000, pitchDeg: -45 }),
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
 * (`WORLD_FOCUS_FRAMING`); a target's own `rangeM`, past the framed radius,
 * stands the camera off that far instead (a target larger than its kind).
 */
export function flyToWorldTarget(viewer, target = {}) {
  const camera = findCamera(viewer);
  const framing = WORLD_FOCUS_FRAMING[target.kind];
  if (!camera || !framing || !isValidWorldFocusTarget(target)) return false;
  // A click's centring: the same flight every clicked thing gets
  // (src/data/clickSelect.js).
  if (
    target.keepView &&
    flyKeepingView(
      camera,
      target.position,
      target.durationSec > 0 ? target.durationSec : undefined,
    )
  )
    return true;
  const pose = camera.pose();
  camera.cancelFlight();
  const heading = Number.isFinite(pose.heading) ? pose.heading : 0;
  const duration =
    target.durationSec > 0
      ? target.durationSec
      : WORLD_CLICK_FOCUS_DURATION_SEC;
  // A target may ask for a wider sphere than its kind's framing (a large
  // quake's disc), never a narrower one.
  const atLeast = (value, floor) =>
    Number.isFinite(value) && value > floor ? value : floor;
  camera.flyToBounds(
    {
      center: target.position,
      radius: atLeast(target.radiusM, framing.radiusM),
    },
    {
      offset: {
        heading,
        pitch: toRadians(framing.pitchDeg),
        // A target's own range past the framed radius replaces the kind's.
        range:
          Number.isFinite(target.rangeM) &&
          target.rangeM > atLeast(target.radiusM, framing.radiusM)
            ? target.rangeM
            : framing.rangeM,
      },
      durationS: duration,
      easing: 'cubicInOut',
    },
  );
  return true;
}
