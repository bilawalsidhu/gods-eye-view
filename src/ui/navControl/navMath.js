/**
 * Pure camera maths for the on-screen navigation control.
 *
 * Everything here works on plain numbers (radians unless a name says Deg) so
 * the clamps, zoom steps and resets can be tested without a Cesium scene. The
 * control orbits the camera around the point under the middle of the screen,
 * so a view is described by `{heading, pitch, range}`: the bearing the camera
 * looks along, its angle below the horizon (negative), and its distance from
 * that target.
 */

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/**
 * Straight-down view. Cesium's `lookAt` is degenerate at exactly -90 degrees
 * (heading has no meaning), so, like the existing tilt button, the control
 * commands -89 and treats it as "top-down".
 */
export const TOP_DOWN_PITCH = -89 * DEG;
/** Closest-to-the-horizon orbit pitch the control will command. */
export const HORIZON_PITCH = -10 * DEG;
/** Tilt slider span in degrees measured up from the top-down view. */
export const TILT_SPAN_DEG = Math.round((HORIZON_PITCH - TOP_DOWN_PITCH) / DEG);
/** Smallest and largest orbit distance a zoom step may reach, in metres. */
export const MIN_RANGE_M = 40;
export const MAX_RANGE_M = 40_000_000;
/** Each zoom step travels this fraction of the current distance to the target. */
export const ZOOM_FRACTION = 0.3;
/** One tilt button press, in degrees. */
export const TILT_STEP_DEG = 10;
/** One keyboard rotate press, in degrees. */
export const ROTATE_STEP_DEG = 15;
/** One look-around nudge, in degrees (it repeats while held). */
export const LOOK_STEP_DEG = 3;
/** Smallest height of the camera above the target's tangent plane. */
export const MIN_CLEARANCE_M = 8;
/** Look-around may raise the gaze this far above the horizon. */
export const LOOK_MAX_PITCH = 30 * DEG;

/** Wrap a heading into [0, 2*PI); non-finite input reads as north. */
export function normalizeHeading(heading) {
  if (!Number.isFinite(heading)) return 0;
  const wrapped = ((heading % TWO_PI) + TWO_PI) % TWO_PI;
  return TWO_PI - wrapped < 1e-10 ? 0 : wrapped;
}

/** Heading in whole degrees, 0-359, for display. */
export function headingDegrees(heading) {
  return Math.round(normalizeHeading(heading) / DEG) % 360;
}

/**
 * Shortest signed turn from one heading to another, in (-PI, PI].
 * Animations use this so north-up from 350 degrees turns 10 degrees, not 350.
 */
export function shortestTurn(from, to) {
  const delta = normalizeHeading(to) - normalizeHeading(from);
  if (delta > Math.PI) return delta - TWO_PI;
  if (delta <= -Math.PI) return delta + TWO_PI;
  return delta;
}

/**
 * The steepest the camera may lean at this distance without sinking below the
 * clearance above the target's tangent plane. At 40 m a 10-degree lean is only
 * 7 m high, so the lean is reduced there rather than driving into the ground.
 */
export function horizonPitchForRange(range, clearanceM = MIN_CLEARANCE_M) {
  if (!Number.isFinite(range) || range <= 0) return TOP_DOWN_PITCH;
  const floor = Math.asin(Math.min(1, clearanceM / range));
  return Math.max(TOP_DOWN_PITCH, Math.min(HORIZON_PITCH, -floor));
}

/**
 * Clamp an orbit pitch to [top-down, near-horizon], tightened by the range.
 * Non-finite input reads as top-down so a bad reading never tips the view.
 */
export function clampPitch(pitch, range = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(pitch)) return TOP_DOWN_PITCH;
  const limit = Number.isFinite(range)
    ? horizonPitchForRange(range)
    : HORIZON_PITCH;
  return Math.min(limit, Math.max(TOP_DOWN_PITCH, pitch));
}

/** Clamp an orbit range to the allowed span; non-finite input is refused. */
export function clampRange(range) {
  if (!Number.isFinite(range)) return MIN_RANGE_M;
  return Math.min(MAX_RANGE_M, Math.max(MIN_RANGE_M, range));
}

/** Slider value (0 top-down .. TILT_SPAN_DEG near-horizon) for a pitch. */
export function pitchToTiltDeg(pitch) {
  if (!Number.isFinite(pitch)) return 0;
  const tilt = (pitch - TOP_DOWN_PITCH) / DEG;
  return Math.min(TILT_SPAN_DEG, Math.max(0, Math.round(tilt)));
}

/** Pitch for a slider value, clamped to the slider's span. */
export function tiltDegToPitch(tiltDeg) {
  const tilt = Number.isFinite(tiltDeg) ? tiltDeg : 0;
  return TOP_DOWN_PITCH + Math.min(TILT_SPAN_DEG, Math.max(0, tilt)) * DEG;
}

/**
 * New orbit distance for one zoom step: a fraction of the current distance,
 * clamped. Zooming out undoes zooming in (divides by the same factor).
 */
export function zoomRange(range, direction, fraction = ZOOM_FRACTION) {
  const base = clampRange(range);
  const keep = 1 - Math.min(0.9, Math.max(0.01, fraction));
  return clampRange(direction === 'in' ? base * keep : base / keep);
}

/** Angle of a pointer around a centre: 0 at the top, clockwise positive. */
export function pointerAngle(centerX, centerY, x, y) {
  return Math.atan2(x - centerX, -(y - centerY));
}

/**
 * Heading while dragging the compass ring. The ring turns with the pointer, so
 * the north mark moves clockwise and the view's bearing moves the other way.
 */
export function headingFromDrag({ startHeading, startAngle, angle }) {
  return normalizeHeading(startHeading - (angle - startAngle));
}

/**
 * Plan one button press against a base view (the current view, or the pending
 * destination when presses are chained). Pure: returns a new view and never
 * touches the camera. Unknown actions return the base unchanged.
 * @param {{heading:number, pitch:number, range:number}} base
 * @param {string} action zoom-in | zoom-out | tilt-up | tilt-down | top-down |
 *   north | rotate-left | rotate-right
 * @param {{zoomFraction?:number, tiltStepDeg?:number, rotateStepDeg?:number}} [options]
 */
export function planAction(base, action, options = {}) {
  const {
    zoomFraction = ZOOM_FRACTION,
    tiltStepDeg = TILT_STEP_DEG,
    rotateStepDeg = ROTATE_STEP_DEG,
  } = options;
  const view = {
    heading: normalizeHeading(base.heading),
    pitch: base.pitch,
    range: clampRange(base.range),
  };
  switch (action) {
    case 'zoom-in':
    case 'zoom-out': {
      view.range = zoomRange(view.range, action.slice(5), zoomFraction);
      break;
    }
    case 'tilt-up':
      view.pitch += tiltStepDeg * DEG;
      break;
    case 'tilt-down':
      view.pitch -= tiltStepDeg * DEG;
      break;
    case 'top-down':
      view.pitch = TOP_DOWN_PITCH;
      break;
    case 'north':
      view.heading = 0;
      break;
    case 'rotate-left':
      view.heading = normalizeHeading(view.heading - rotateStepDeg * DEG);
      break;
    case 'rotate-right':
      view.heading = normalizeHeading(view.heading + rotateStepDeg * DEG);
      break;
    default:
      return { ...view, pitch: clampPitch(view.pitch, view.range) };
  }
  view.pitch = clampPitch(view.pitch, view.range);
  return view;
}

/**
 * Raise a pitch until the camera clears the surface under it.
 *
 * `clearanceAt(pitch)` answers how many metres the camera would sit above the
 * surface at that pitch, or NaN when the surface is unknown (tiles not
 * streamed); an unknown surface never changes the pitch. The pitch moves
 * toward top-down in 2-degree steps, which always ends because top-down is the
 * highest the camera can be for a given distance.
 */
export function liftPitchForClearance(
  pitch,
  clearanceAt,
  minClearanceM = MIN_CLEARANCE_M,
) {
  let next = pitch;
  for (let i = 0; i < 50 && next > TOP_DOWN_PITCH; i++) {
    const clearance = clearanceAt(next);
    if (!Number.isFinite(clearance) || clearance >= minClearanceM) return next;
    next = Math.max(TOP_DOWN_PITCH, next - 2 * DEG);
  }
  return next;
}

/**
 * Look around from where the camera is (the joystick): turn the gaze by a
 * step without moving the camera. Roll stays zero, pitch is clamped between
 * straight down and a little above the horizon.
 * @param {{heading:number, pitch:number}} look
 * @param {'look-left'|'look-right'|'look-up'|'look-down'} action
 */
export function planLook(look, action, stepDeg = LOOK_STEP_DEG) {
  let heading = normalizeHeading(look.heading);
  let pitch = Number.isFinite(look.pitch) ? look.pitch : TOP_DOWN_PITCH;
  const step = stepDeg * DEG;
  if (action === 'look-left') heading = normalizeHeading(heading - step);
  else if (action === 'look-right') heading = normalizeHeading(heading + step);
  else if (action === 'look-up') pitch += step;
  else if (action === 'look-down') pitch -= step;
  return {
    heading,
    pitch: Math.min(LOOK_MAX_PITCH, Math.max(TOP_DOWN_PITCH, pitch)),
  };
}

/** Cubic ease-in-out for a 0..1 progress value. */
export function easeInOut(progress) {
  const t = Math.min(1, Math.max(0, progress));
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
