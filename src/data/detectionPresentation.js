/** Drone View brackets stay legible without dominating mission telemetry. */
export const DRONE_VIEW_BRACKET_OPACITY = 0.45;

/**
 * Resolve the bracket-only opacity multiplier for the current presentation.
 * Detection callouts and user tuning are intentionally unaffected.
 * @param {boolean} droneViewActive - Whether Drone View owns the viewport.
 * @returns {number} Bracket stroke opacity multiplier.
 */
export function detectionBracketOpacity(droneViewActive) {
  return droneViewActive === true ? DRONE_VIEW_BRACKET_OPACITY : 1;
}
