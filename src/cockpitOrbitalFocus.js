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

/** How often the list of mapped points in reach is rebuilt, ms. */
export const ORBITAL_REACH_REFRESH_MS = 1000;

/** The most mapped points the reach list shows, nearest to nadir first. */
export const ORBITAL_REACH_LIST_MAX = 12;

/** The most detail rows (OpenStreetMap tags or properties) shown per point. */
export const ORBITAL_REACH_DETAIL_MAX = 16;

/** Slack on the reach limit so a target held exactly at 45° stays. */
const REACH_EPSILON_DEG = 1e-6;

const WGS84_A = 6378137;
const WGS84_E2 = 6.69437999014e-3;

const toRadians = (deg) => (deg * Math.PI) / 180;
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
 * Earth-fixed position of a geodetic point on the WGS84 ellipsoid, as
 * Cesium's `Cartesian3.fromDegrees` places it.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {number} [heightM] Height above the ellipsoid.
 * @returns {{x: number, y: number, z: number}|null}
 */
export function geodeticToEcef(latDeg, lonDeg, heightM = 0) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
  const h = Number.isFinite(heightM) ? heightM : 0;
  const lat = toRadians(latDeg);
  const lon = toRadians(lonDeg);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (n + h) * cosLat * Math.cos(lon),
    y: (n + h) * cosLat * Math.sin(lon),
    z: (n * (1 - WGS84_E2) + h) * sinLat,
  };
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
  // The target's own zenith: the satellite is above its horizon when the
  // line from the target to it points up.
  const targetRadius = Math.hypot(target.x, target.y, target.z);
  const visible =
    targetRadius > 0 &&
    -(line.x * target.x + line.y * target.y + line.z * target.z) /
      targetRadius >
      0;
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
 * Whether `target` is inside the picture as it is now framed.
 * @param {{direction: object, up: object, right: object}} view The camera's
 *   orientation (the nadir frame tilted by the eased look).
 * @param {{x: number, y: number, z: number}} satellite ECEF, metres.
 * @param {{x: number, y: number, z: number}} target ECEF, metres.
 * @param {{verticalFovRad: number, aspect?: number}} frame
 * @returns {boolean}
 */
export function inFrame(
  view,
  satellite,
  target,
  { verticalFovRad, aspect = 1 },
) {
  if (!view || !finiteVector(satellite) || !finiteVector(target)) return false;
  if (!(verticalFovRad > 0)) return false;
  const line = {
    x: target.x - satellite.x,
    y: target.y - satellite.y,
    z: target.z - satellite.z,
  };
  const along = dot(line, view.direction);
  if (!(along > 0)) return false;
  const halfTan = Math.tan(verticalFovRad / 2);
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return (
    Math.abs(dot(line, view.up)) / along <= halfTan &&
    Math.abs(dot(line, view.right)) / along <= halfTan * ratio
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
 * The mapped points the view shows now or can be turned to: those facing
 * the satellite and either within the off-nadir reach (`reachable`) or in
 * the frame as it is. Nearest to nadir first, at most `max`.
 * @param {Iterable<{key: string, position: {x: number, y: number,
 *   z: number}}>} candidates
 * @param {{nadir: object, view: object, satellite: object,
 *   verticalFovRad: number, aspect?: number, max?: number}} frame
 * @returns {{count: number, entries: Array<{key: string,
 *   offNadirDeg: number, reachable: boolean, look: object}>}} `count` is
 *   every point in reach, `entries` the nearest.
 */
export function pointsInReach(
  candidates,
  {
    nadir,
    view,
    satellite,
    verticalFovRad,
    aspect = 1,
    max = ORBITAL_REACH_LIST_MAX,
  },
) {
  const entries = [];
  if (!nadir || !finiteVector(satellite)) return { count: 0, entries };
  for (const candidate of candidates) {
    const look = focusLook(nadir, satellite, candidate?.position);
    if (!look?.visible) continue;
    const reachable = focusInReach(look);
    if (
      !reachable &&
      !inFrame(view, satellite, candidate.position, { verticalFovRad, aspect })
    )
      continue;
    entries.push({
      key: candidate.key,
      offNadirDeg: look.offNadirDeg,
      reachable,
      look,
    });
  }
  entries.sort(
    (a, b) =>
      a.offNadirDeg - b.offNadirDeg || String(a.key).localeCompare(b.key),
  );
  const limit =
    Number.isInteger(max) && max >= 0 ? max : ORBITAL_REACH_LIST_MAX;
  return { count: entries.length, entries: entries.slice(0, limit) };
}

/**
 * A mapped point's details as key/value rows: its OpenStreetMap tags, or the
 * properties its layer keeps. Text, numbers and lists of text only; keys
 * starting with `_` are internal. At most `max` rows, in the layer's order.
 * @param {object|null|undefined} properties
 * @param {number} [max]
 * @returns {Array<{key: string, value: string}>}
 */
export function detailRows(properties, max = ORBITAL_REACH_DETAIL_MAX) {
  const rows = [];
  if (!properties || typeof properties !== 'object') return rows;
  for (const [key, raw] of Object.entries(properties)) {
    if (rows.length >= max) break;
    if (!key || key.startsWith('_')) continue;
    let value = null;
    if (typeof raw === 'string') value = raw.trim();
    else if (typeof raw === 'number' && Number.isFinite(raw))
      value = String(raw);
    else if (typeof raw === 'boolean') value = raw ? 'yes' : 'no';
    else if (Array.isArray(raw)) {
      const items = raw
        .filter((item) => typeof item === 'string' && item.trim())
        .map((item) => item.trim());
      value = items.join(', ');
    }
    if (value) rows.push({ key, value });
  }
  return rows;
}
