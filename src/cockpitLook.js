/**
 * Bridge look-around policy: how the arrow keys turn the bridge camera away
 * from the bow and back, and how a turned view is described. Yaw is relative
 * to the ship's heading; pitch is the view's absolute pitch. Pure: no DOM, no
 * Cesium and no translated text; the Cockpit words the readout.
 */

/** One arrow press turns the view this far. */
export const LOOK_STEP_DEG = 5;

/** One Shift+arrow press turns the view this far: two reach either beam. */
export const LOOK_COARSE_STEP_DEG = 45;

/** The view pitches no further than straight up or straight down. */
export const LOOK_PITCH_LIMIT_DEG = 90;

/**
 * The eased view's time constant. Three of them (about 180 ms) close 95% of
 * a step, so a press glides rather than snaps and a held key turns smoothly.
 */
export const LOOK_EASE_TAU_MS = 60;

/** Closer than this the eased view lands on its target. */
const LOOK_SETTLE_DEG = 0.05;

/** Arrow key → the axis it turns and the direction it turns it. */
const LOOK_ARROWS = Object.freeze({
  ArrowLeft: Object.freeze({ axis: 'yaw', sign: -1 }),
  ArrowRight: Object.freeze({ axis: 'yaw', sign: 1 }),
  ArrowUp: Object.freeze({ axis: 'pitch', sign: 1 }),
  ArrowDown: Object.freeze({ axis: 'pitch', sign: -1 }),
});

/**
 * Wrap a yaw to (-180, 180]: negative to port, positive to starboard.
 * @param {number} deg Yaw in degrees; a non-finite yaw reads as ahead.
 * @returns {number}
 */
export function wrapLookYaw(deg) {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = (((deg % 360) + 360) % 360) - 360;
  const yaw = wrapped <= -180 ? wrapped + 360 : wrapped;
  return yaw === 0 ? 0 : yaw;
}

/**
 * Clamp a view pitch to [-90, 90].
 * @param {number} deg Pitch in degrees; a non-finite pitch reads as level.
 * @returns {number}
 */
export function clampLookPitch(deg) {
  if (!Number.isFinite(deg)) return 0;
  const pitch = Math.min(
    LOOK_PITCH_LIMIT_DEG,
    Math.max(-LOOK_PITCH_LIMIT_DEG, deg),
  );
  return pitch === 0 ? 0 : pitch;
}

/**
 * The step an arrow key asks for, or null for any other key.
 * @param {string} key `KeyboardEvent.key`.
 * @param {boolean} [coarse] Shift is held: step 45° instead of 5°.
 * @returns {{axis: 'yaw'|'pitch', sign: 1|-1, stepDeg: number}|null}
 */
export function lookKeyStep(key, coarse = false) {
  const arrow = LOOK_ARROWS[key];
  if (!arrow) return null;
  return {
    ...arrow,
    stepDeg: coarse ? LOOK_COARSE_STEP_DEG : LOOK_STEP_DEG,
  };
}

/**
 * Move one value to the next multiple of `stepDeg` in the direction `sign`.
 * A value off the grid (the bridge's -2° rest pitch) lands on it first, so
 * the readout shows round angles.
 */
function nextOnGrid(value, sign, stepDeg) {
  const cells = value / stepDeg;
  const next =
    sign > 0 ? Math.floor(cells + 1e-9) + 1 : Math.ceil(cells - 1e-9) - 1;
  return next * stepDeg;
}

/**
 * Apply one key step to a look target.
 * @param {{yawDeg: number, pitchDeg: number}} target Current look target.
 * @param {{axis: 'yaw'|'pitch', sign: number, stepDeg: number}} step From
 *   {@link lookKeyStep}.
 * @returns {{yawDeg: number, pitchDeg: number}} The new target: yaw wrapped
 *   to (-180, 180], pitch clamped to [-90, 90].
 */
export function stepLook(target, step) {
  const yawDeg = wrapLookYaw(target?.yawDeg ?? 0);
  const pitchDeg = clampLookPitch(target?.pitchDeg ?? 0);
  if (!step) return { yawDeg, pitchDeg };
  if (step.axis === 'yaw')
    return {
      yawDeg: wrapLookYaw(nextOnGrid(yawDeg, step.sign, step.stepDeg)),
      pitchDeg,
    };
  return {
    yawDeg,
    pitchDeg: clampLookPitch(nextOnGrid(pitchDeg, step.sign, step.stepDeg)),
  };
}

/**
 * Advance the eased view toward its target. Yaw takes the shorter way
 * round; with `immediate` (reduced motion) the view jumps to the target.
 * @param {{yawDeg: number, pitchDeg: number}} current Eased view now.
 * @param {{yawDeg: number, pitchDeg: number}} target Look target.
 * @param {number} dtMs Milliseconds since the previous step.
 * @param {{immediate?: boolean}} [options]
 * @returns {{yawDeg: number, pitchDeg: number}}
 */
export function easeLook(current, target, dtMs, { immediate = false } = {}) {
  const goalYaw = wrapLookYaw(target?.yawDeg ?? 0);
  const goalPitch = clampLookPitch(target?.pitchDeg ?? 0);
  if (immediate || !current) return { yawDeg: goalYaw, pitchDeg: goalPitch };
  const fraction =
    Number.isFinite(dtMs) && dtMs > 0
      ? 1 - Math.exp(-dtMs / LOOK_EASE_TAU_MS)
      : 0;
  const fromYaw = wrapLookYaw(current.yawDeg);
  const yawError = wrapLookYaw(goalYaw - fromYaw);
  const pitchError = goalPitch - clampLookPitch(current.pitchDeg);
  const yawDeg =
    Math.abs(yawError * (1 - fraction)) < LOOK_SETTLE_DEG
      ? goalYaw
      : wrapLookYaw(fromYaw + yawError * fraction);
  const pitchDeg =
    Math.abs(pitchError * (1 - fraction)) < LOOK_SETTLE_DEG
      ? goalPitch
      : clampLookPitch(current.pitchDeg + pitchError * fraction);
  return { yawDeg, pitchDeg };
}

/**
 * Whether a look differs from the rest view (ahead at `restPitchDeg`).
 * @param {{yawDeg: number, pitchDeg: number}} look
 * @param {number} restPitchDeg The camera profile's pitch.
 * @returns {boolean}
 */
export function lookIsOffset(look, restPitchDeg) {
  return (
    wrapLookYaw(look?.yawDeg ?? 0) !== 0 ||
    clampLookPitch(look?.pitchDeg ?? restPitchDeg) !==
      clampLookPitch(restPitchDeg)
  );
}

/**
 * The parts of a look readout, for the Cockpit to word. A part is null when
 * that axis rests: yaw ahead, or pitch at the rest pitch.
 * @param {{yawDeg: number, pitchDeg: number}} look Look target.
 * @param {number} restPitchDeg The camera profile's pitch.
 * @returns {{side: 'port'|'starboard'|'astern'|null, bearingDeg: number,
 *   elevation: 'up'|'down'|'level'|null, angleDeg: number}} `bearingDeg` is
 *   the angle off the bow (0–180) and `angleDeg` the angle off level (0–90),
 *   both rounded to whole degrees.
 */
export function lookReadoutParts(look, restPitchDeg) {
  const yaw = Math.round(wrapLookYaw(look?.yawDeg ?? 0));
  const pitch = Math.round(clampLookPitch(look?.pitchDeg ?? restPitchDeg));
  const pitchOffset =
    clampLookPitch(look?.pitchDeg ?? restPitchDeg) !==
    clampLookPitch(restPitchDeg);
  let side = null;
  if (Math.abs(yaw) >= 180) side = 'astern';
  else if (yaw > 0) side = 'starboard';
  else if (yaw < 0) side = 'port';
  let elevation = null;
  if (pitchOffset) elevation = pitch > 0 ? 'up' : pitch < 0 ? 'down' : 'level';
  return {
    side,
    bearingDeg: Math.abs(yaw),
    elevation,
    angleDeg: Math.abs(pitch),
  };
}

/**
 * The orbital view's off-nadir limit on each axis. The orbital look reuses
 * the bridge's `{yawDeg, pitchDeg}` shape over a fixed nadir frame: yaw tilts
 * the view east (positive) or west, pitch tilts it north (positive) or
 * south. Single 5° steps only; the bridge keeps its own limits.
 */
export const ORBITAL_LOOK_LIMIT_DEG = 45;

/** Clamp one orbital look axis to ±ORBITAL_LOOK_LIMIT_DEG; NaN rests. */
function clampOrbitalAxis(deg) {
  if (!Number.isFinite(deg)) return 0;
  const value = Math.min(
    ORBITAL_LOOK_LIMIT_DEG,
    Math.max(-ORBITAL_LOOK_LIMIT_DEG, deg),
  );
  return value === 0 ? 0 : value;
}

/**
 * Clamp an orbital look to the off-nadir limit on both axes.
 * @param {{yawDeg: number, pitchDeg: number}} look East and north tilt.
 * @returns {{yawDeg: number, pitchDeg: number}}
 */
export function clampOrbitalLook(look) {
  return {
    yawDeg: clampOrbitalAxis(look?.yawDeg),
    pitchDeg: clampOrbitalAxis(look?.pitchDeg),
  };
}

/**
 * Apply one arrow step to an orbital look: the bridge's stepping on the
 * same 5° grid, then the off-nadir clamp.
 * @param {{yawDeg: number, pitchDeg: number}} target Current look target.
 * @param {{axis: 'yaw'|'pitch', sign: number, stepDeg: number}} step From
 *   {@link lookKeyStep}.
 * @returns {{yawDeg: number, pitchDeg: number}}
 */
export function stepOrbitalLook(target, step) {
  return clampOrbitalLook(stepLook(clampOrbitalLook(target), step));
}

/**
 * The parts of an off-nadir readout, for the Cockpit to word: the north or
 * south tilt and the east or west tilt, each null at rest, in whole degrees.
 * @param {{yawDeg: number, pitchDeg: number}} look Orbital look target.
 * @returns {{northSouth: 'N'|'S'|null, northSouthDeg: number,
 *   eastWest: 'E'|'W'|null, eastWestDeg: number}}
 */
export function orbitalLookReadoutParts(look) {
  const { yawDeg, pitchDeg } = clampOrbitalLook(look);
  const north = Math.round(pitchDeg);
  const east = Math.round(yawDeg);
  return {
    northSouth: north > 0 ? 'N' : north < 0 ? 'S' : null,
    northSouthDeg: Math.abs(north),
    eastWest: east > 0 ? 'E' : east < 0 ? 'W' : null,
    eastWestDeg: Math.abs(east),
  };
}
