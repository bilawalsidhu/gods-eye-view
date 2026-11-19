/**
 * Ground focus for the orbital view: the look that keeps a point on the
 * ground at the centre of the picture as the satellite moves, whether that
 * look is within the off-nadir reach, and which mapped points the view can
 * show or be turned to. The look is the orbital view's own
 * `{yawDeg, pitchDeg}` over its nadir frame (see `offNadirOrientation` in
 * `src/cockpitOrbital.js`), so a focused view is a tilt like any other.
 * No DOM, Cesium or i18n dependencies: vectors are plain `{x, y, z}` objects
 * in Earth-fixed (ECEF) metres.
 */
import {
  LOOK_EASE_TAU_MS,
  ORBITAL_LOOK_LIMIT_DEG,
  easeLook,
} from './cockpitLook.js';

/**
 * How long a focus takes to swing the view onto its target, or back to
 * nadir when it ends: the look's own easing curve, on a slower clock. Three
 * of them (about 0.75 s) close 95% of the turn.
 */
export const ORBITAL_FOCUS_EASE_TAU_MS = 250;

/** How often the orbital Live Signals rows are rebuilt, ms. */
export const ORBITAL_REACH_REFRESH_MS = 1000;

/** WGS84 semi-axes squared, m²: the surface normal for the horizon test. */
const WGS84_A2 = 6378137 ** 2;
const WGS84_B2 = 6356752.314245179 ** 2;

/** Slack on the reach limit so a target held exactly at 45° stays. */
const REACH_EPSILON_DEG = 1e-6;

const toDegrees = (rad) => (rad * 180) / Math.PI;

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function finiteVector(v) {
  return (
    Boolean(v) &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z)
  );
}

/**
 * The look that centres `target` in the picture, in the nadir frame's tilt
 * (north first, then east; see `offNadirOrientation`): east is the angle off
 * the frame's top-bottom plane, north the angle along it. Also the single
 * angle between nadir and the line of sight, the image's off-nadir angle,
 * and whether the target faces the satellite (above its horizon).
 * @param {{direction: object, up: object, right: object}} nadir From
 *   `nadirOrientation`.
 * @param {{x: number, y: number, z: number}} satellite ECEF, metres.
 * @param {{x: number, y: number, z: number}} target ECEF, metres.
 * @returns {{yawDeg: number, pitchDeg: number, offNadirDeg: number,
 *   visible: boolean}|null} Null without usable positions.
 */
export function focusLook(nadir, satellite, target) {
  if (!nadir || !finiteVector(satellite) || !finiteVector(target)) return null;
  const line = {
    x: target.x - satellite.x,
    y: target.y - satellite.y,
    z: target.z - satellite.z,
  };
  const range = Math.hypot(line.x, line.y, line.z);
  if (!(range > 1)) return null;
  const v = { x: line.x / range, y: line.y / range, z: line.z / range };
  const along = dot(v, nadir.direction);
  const up = dot(v, nadir.up);
  const right = Math.min(1, Math.max(-1, dot(v, nadir.right)));
  // The target's own zenith, the WGS84 surface normal there: the satellite
  // is above its horizon when the line from the target to it points up.
  const normal = {
    x: target.x / WGS84_A2,
    y: target.y / WGS84_A2,
    z: target.z / WGS84_B2,
  };
  const visible =
    Math.hypot(normal.x, normal.y, normal.z) > 0 && -dot(line, normal) > 0;
  const yawDeg = toDegrees(Math.asin(right));
  const pitchDeg = toDegrees(Math.atan2(up, along));
  return {
    yawDeg: yawDeg === 0 ? 0 : yawDeg,
    pitchDeg: pitchDeg === 0 ? 0 : pitchDeg,
    offNadirDeg: toDegrees(Math.acos(Math.min(1, Math.max(-1, along)))),
    visible,
  };
}

/**
 * Whether a focus look is within the off-nadir reach: the target faces the
 * satellite and each axis is within the arrows' ±45° clamp.
 * @param {{yawDeg: number, pitchDeg: number, visible?: boolean}|null} look
 * @returns {boolean}
 */
export function focusInReach(look) {
  if (!look || look.visible === false) return false;
  const limit = ORBITAL_LOOK_LIMIT_DEG + REACH_EPSILON_DEG;
  return (
    Number.isFinite(look.yawDeg) &&
    Number.isFinite(look.pitchDeg) &&
    Math.abs(look.yawDeg) <= limit &&
    Math.abs(look.pitchDeg) <= limit
  );
}

/**
 * Ease what is left of the turn onto a focus target toward nothing: the
 * look's easing (`easeLook`) on the focus's slower clock. The view is the
 * live target's look plus this remainder, so once it lands the view holds
 * the target exactly, without the lag of chasing it. Reduced motion cuts.
 * @param {{yawDeg: number, pitchDeg: number}} remainder View minus target.
 * @param {number} dtMs Milliseconds since the previous frame.
 * @param {{immediate?: boolean}} [options]
 * @returns {{yawDeg: number, pitchDeg: number}}
 */
export function easeFocusRemainder(
  remainder,
  dtMs,
  { immediate = false } = {},
) {
  return easeLook(remainder, { yawDeg: 0, pitchDeg: 0 }, focusEaseDtMs(dtMs), {
    immediate,
  });
}

/**
 * A frame's time on the focus's clock, for `easeLook`: its fixed time
 * constant scaled to ORBITAL_FOCUS_EASE_TAU_MS.
 * @param {number} dtMs
 * @returns {number}
 */
export function focusEaseDtMs(dtMs) {
  return Number.isFinite(dtMs) && dtMs > 0
    ? (dtMs * LOOK_EASE_TAU_MS) / ORBITAL_FOCUS_EASE_TAU_MS
    : 0;
}

/**
 * The mapped points the view can be turned to: those facing the satellite
 * and within the off-nadir reach, nearest to nadir first.
 * @param {Iterable<{key: string, position: {x: number, y: number,
 *   z: number}}>} candidates
 * @param {{nadir: object, satellite: object}} frame
 * @returns {Array<{key: string, offNadirDeg: number, look: object}>}
 */
export function pointsInReach(candidates, { nadir, satellite }) {
  const entries = [];
  if (!nadir || !finiteVector(satellite)) return entries;
  for (const candidate of candidates) {
    const look = focusLook(nadir, satellite, candidate?.position);
    if (!focusInReach(look)) continue;
    entries.push({ key: candidate.key, offNadirDeg: look.offNadirDeg, look });
  }
  return entries.sort(
    (a, b) =>
      a.offNadirDeg - b.offNadirDeg || String(a.key).localeCompare(b.key),
  );
}
