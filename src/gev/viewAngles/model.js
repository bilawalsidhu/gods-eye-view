/**
 * Pure view-angle math for the angle controls. No Cesium, no DOM.
 *
 * Pitch is in degrees below the horizon as Cesium measures it: -89 is
 * straight down, -10 is nearly level. Heading is degrees clockwise from
 * north, 0..359.
 */

export const MIN_PITCH = -89;
/** Closest to the horizon we allow; flatter than this skims the ground. */
export const MAX_PITCH = -8;
export const TILT_STEP = 10;
export const ROTATE_STEP = 15;

export const ANGLE_PRESETS = Object.freeze([
  { id: 'top', label: 'Top', pitch: -89 },
  { id: 'high', label: '60°', pitch: -60 },
  { id: 'oblique', label: '35°', pitch: -35 },
  { id: 'low', label: '15°', pitch: -15 },
]);

export function clampPitch(deg) {
  if (!Number.isFinite(deg)) return MIN_PITCH;
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, deg));
}

export function normalizeHeading(deg) {
  if (!Number.isFinite(deg)) return 0;
  const h = ((deg % 360) + 360) % 360;
  return Math.abs(h - 360) < 1e-9 ? 0 : h;
}

/** Tilt toward the horizon (positive steps) or toward straight down. */
export function stepPitch(currentDeg, steps) {
  return clampPitch(clampPitch(currentDeg) + steps * TILT_STEP);
}

/** Rotate clockwise (positive steps) or counter-clockwise. */
export function stepHeading(currentDeg, steps) {
  return normalizeHeading(normalizeHeading(currentDeg) + steps * ROTATE_STEP);
}

/** Preset whose pitch is within 4 degrees of the current pitch, if any. */
export function activePreset(pitchDeg) {
  if (!Number.isFinite(pitchDeg)) return null;
  return ANGLE_PRESETS.find((p) => Math.abs(p.pitch - pitchDeg) <= 4) || null;
}

/** Human readout: "35° down · facing 270° W". */
export function describeAngle(pitchDeg, headingDeg) {
  const down = Math.round(-clampPitch(pitchDeg));
  const h = Math.round(normalizeHeading(headingDeg)) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const dir = dirs[Math.round(h / 45) % 8];
  return `${down}° down · facing ${h}° ${dir}`;
}

/**
 * Keyboard map. Keys chosen to avoid the app's existing shortcuts
 * (1-7 styles, h, o, v, f, d, c, backtick).
 */
export const ANGLE_KEYS = Object.freeze({
  '[': { tilt: -1 },
  ']': { tilt: 1 },
  ',': { rotate: -1 },
  '.': { rotate: 1 },
});
