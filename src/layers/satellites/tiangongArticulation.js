import { sunPositionFixed } from '../../geo/celestial.js';
import {
  ISS_JOINT_RATE,
  issAimMatrix,
  issArmAngles,
  issAxisMatrix,
  issInShadow,
  issRelayDirections,
  issStepAngle,
  issStepDirection,
  issSunInModelFrame,
} from './issArticulation.js';
import { tiangongJoint } from './tiangongJoints.js';

/**
 * Tiangong's moving parts, driven from the joint table (tiangongJoints.js):
 * every angle is computed, since China publishes no live telemetry for the
 * station. The rules are the ISS's (issArticulation.js), written for joints
 * whose axes and rest normals come from the table instead of being fixed:
 *
 * - a wing on one joint (Tianhe's two, each visiting vehicle's two) turns
 *   about its boom so its cell side faces the Sun;
 * - a lab wing (Wentian's and Mengtian's two each) turns first about the
 *   lab's axis (alpha), so the wing's own axis is across the Sun, then about
 *   that axis (beta), so the cells face it, the ISS's SARJ/BGA pair;
 * - in the Earth's shadow the wings turn flat to the Earth (cell side to
 *   zenith), which puts them edge-on to the flight direction, the ISS's
 *   feathering;
 * - the high-gain antenna aims at the highest of China's Tianlian relay
 *   satellites over the equator;
 * - the two arms sway slowly for illustration (their real pose is not public).
 *
 * Joints turn at most ISS_JOINT_RATE on screen.
 */

/** Below this the Sun is too close to a joint's axis to steer by it. */
const MIN_STEER = 0.05;
/** The dish does not look below this much above the station's horizon plane. */
const DISH_MIN_UP = 0.15;
/** Where the wings turn in shadow: cell side to zenith, on the model's axes. */
const ZENITH = Object.freeze([0, 1, 0]);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** `v` turned by `angle` about the unit vector `axis` (Rodrigues). */
function rotate(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [0, 1, 2].map((i) => v[i] * c + k[i] * s + axis[i] * d);
}

/** The signed difference wrapped to (-π, π]. */
function wrap(delta) {
  let d = delta % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Of `angle` and `angle + π`, the one nearer to `previous`. */
function nearestHalfTurn(angle, previous) {
  const flipped = angle + Math.PI;
  return Math.abs(wrap(angle - previous)) <= Math.abs(wrap(flipped - previous))
    ? angle
    : flipped;
}

const wing = (node, normal) =>
  Object.freeze({ ...tiangongJoint(node), normal: Object.freeze(normal) });

/**
 * Wings turned by one joint, with the cell side's normal at rest. The
 * station's and the forward and aft vehicles' wings lie flat (cells up); the
 * nadir Shenzhou hangs below the node, so its wings' cells face forward.
 */
export const TIANGONG_ONE_AXIS_WINGS = Object.freeze([
  wing('TIANHE_ARRAY_PORT_ALPHA', ZENITH),
  wing('TIANHE_ARRAY_STBD_ALPHA', ZENITH),
  wing('SHENZHOU_FORWARD_ARRAY_PORT_ALPHA', ZENITH),
  wing('SHENZHOU_FORWARD_ARRAY_STBD_ALPHA', ZENITH),
  wing('SHENZHOU_NADIR_ARRAY_PORT_ALPHA', [0, 0, 1]),
  wing('SHENZHOU_NADIR_ARRAY_STBD_ALPHA', [0, 0, 1]),
  wing('TIANZHOU_AFT_ARRAY_PORT_ALPHA', ZENITH),
  wing('TIANZHOU_AFT_ARRAY_STBD_ALPHA', ZENITH),
]);

/** The lab wings: an alpha joint about the lab's axis, a beta joint under it. */
export const TIANGONG_TWO_AXIS_WINGS = Object.freeze(
  [
    'WENTIAN_ARRAY_FWD',
    'WENTIAN_ARRAY_AFT',
    'MENGTIAN_ARRAY_FWD',
    'MENGTIAN_ARRAY_AFT',
  ].map((stem) =>
    Object.freeze({
      alpha: tiangongJoint(`${stem}_ALPHA`),
      beta: tiangongJoint(`${stem}_BETA`),
      normal: ZENITH,
    }),
  ),
);

/**
 * The arms' joints, base to tip, with the illustrative sway: `centre` and
 * `sway` radians over `period` seconds, about the folded pose in the file.
 * The joints that lift the booms sway on one side of rest only, so the arms
 * rise off the hull and never swing into it.
 */
const arm = (prefix, sway) =>
  Object.freeze(
    ['SHR', 'SHY', 'SHP', 'EP', 'WP', 'WY', 'WR'].map((name) => {
      const [centreDeg = 0, swayDeg = 0, period = 0] = sway[name] ?? [];
      return Object.freeze({
        ...tiangongJoint(`${prefix}_${name}`),
        centre: (centreDeg * Math.PI) / 180,
        sway: (swayDeg * Math.PI) / 180,
        period,
      });
    }),
  );

export const TIANGONG_ARMS = Object.freeze({
  /** The Tianhe arm (CMM), its booms folded along the core module. */
  cmm: arm('CMM', { SHP: [12, 6, 71], EP: [-14, 8, 53], WP: [0, 5, 41] }),
  /** The Wentian arm (EMM), folded along the lab. */
  emm: arm('EMM', { SHP: [-12, 6, 67], EP: [14, 8, 47], WP: [0, 5, 37] }),
});

/** The high-gain antenna's gimbal; rest boresight +Y. */
export const TIANGONG_HGA = tiangongJoint('TIANHE_HGA');

/**
 * China's Tianlian II relay satellites over the equator, degrees east, the
 * station's counterparts to NASA's TDRS: II-01 at 79.9°E, II-02 at 171.04°E,
 * II-03 at 10.5°E (Wikipedia, "Tianlian", and satcat.com's definitive orbit
 * for 53100 at 10.56°E; II-03's slot is not stated by the launch reports, which
 * say only that the three form a global network). Nominal slots, not a live
 * roster: which satellite the station uses at a given moment is not public.
 */
export const TIANGONG_RELAY_LONGITUDES_DEG = Object.freeze([
  79.9, 171.04, 10.5,
]);

/**
 * The angle that turns a wing's cell side onto the Sun about one axis.
 * @param {number[]} sun Unit vector on the model's axes.
 * @param {{axis: readonly number[], normal: readonly number[]}} joint The
 *   turn axis and the cell side's normal at rest (perpendicular to it).
 * @param {number} [previous] Held when the Sun is along the axis.
 * @returns {number} Radians.
 */
export function tiangongOneAxisAngle(sun, { axis, normal }, previous = 0) {
  const across = cross(axis, normal);
  const u = dot(sun, normal);
  const v = dot(sun, across);
  if (Math.hypot(u, v) < MIN_STEER) return previous;
  return Math.atan2(v, u);
}

/**
 * The two angles that face a lab wing to the Sun: `alpha` about the lab's
 * axis puts the wing's own axis across the Sun, `beta` about that axis turns
 * the cell side onto it.
 * @param {number[]} sun Unit vector on the model's axes.
 * @param {{alphaAxis: readonly number[], betaAxis: readonly number[],
 *   normal: readonly number[]}} joint Axes at rest; the normal is
 *   perpendicular to both.
 * @param {number} [previousAlpha] Alpha has two answers half a turn apart
 *   (beta makes up the difference); the nearer to this is kept, and it is
 *   held when the Sun is along the alpha axis.
 * @returns {{alpha: number, beta: number}} Radians.
 */
export function tiangongTwoAxisAngles(
  sun,
  { alphaAxis, betaAxis, normal },
  previousAlpha = 0,
) {
  const across = cross(alphaAxis, betaAxis);
  const u = dot(sun, betaAxis);
  const v = dot(sun, across);
  const alpha =
    Math.hypot(u, v) < MIN_STEER
      ? previousAlpha
      : nearestHalfTurn(Math.atan2(-u, v), previousAlpha);
  // The Sun as the wing sees it after the alpha turn.
  const local = rotate(sun, alphaAxis, -alpha);
  const beta = Math.atan2(
    dot(local, cross(betaAxis, normal)),
    dot(local, normal),
  );
  return { alpha, beta };
}

/**
 * Every wing's target angles.
 * @param {number[]} sun Unit vector toward the Sun on the model's axes.
 * @param {boolean} sunlit False in the Earth's shadow: the wings turn flat.
 * @param {{one: number[], alpha: number[]}} [previous] The last targets.
 * @returns {{one: number[], alpha: number[], beta: number[]}} Radians, per
 *   TIANGONG_ONE_AXIS_WINGS and TIANGONG_TWO_AXIS_WINGS entry.
 */
export function tiangongWingTargets(sun, sunlit, previous = null) {
  const toward = sunlit ? sun : ZENITH;
  const one = TIANGONG_ONE_AXIS_WINGS.map((joint, i) =>
    tiangongOneAxisAngle(toward, joint, previous?.one[i] ?? 0),
  );
  const two = TIANGONG_TWO_AXIS_WINGS.map((pair, i) =>
    tiangongTwoAxisAngles(
      toward,
      {
        alphaAxis: pair.alpha.axis,
        betaAxis: pair.beta.axis,
        normal: pair.normal,
      },
      previous?.alpha[i] ?? 0,
    ),
  );
  return {
    one,
    alpha: two.map((t) => t.alpha),
    beta: two.map((t) => t.beta),
  };
}

/**
 * Where the Tianlian satellites are from the station, on the model's axes,
 * the highest above the station first.
 * @param {number[]} positionEcef Meters.
 * @param {{x:number[], y:number[], z:number[]}} axes Flight axes.
 * @returns {number[][]} Unit vectors [port, zenith, forward].
 */
export function tiangongRelayDirections(positionEcef, axes) {
  return issRelayDirections(positionEcef, axes, TIANGONG_RELAY_LONGITUDES_DEG);
}

/**
 * Drives the loaded model's joints. Same contract as the ISS driver
 * (`update`, `reset`, the STATION section's `setOverride`, `setJoint`,
 * `resumeArm`, `isSunlit`), minus telemetry: `isLive` is always false.
 */
export function createTiangongArticulation() {
  let boundModel = null;
  let nodes = null;
  let angles = null;
  let targets = null;
  let lastMs = 0;
  let override = null;
  let lastSunlit = null;
  /** Where the dish looks now, on the model's axes. */
  let dish = null;
  /** STATION section: arms being posed by hand, so their sway is off. */
  const armManual = new Set();
  /**
   * STATION section: wings set by hand, node name → radians. A wing with an
   * entry here holds that angle (reached at the joint rate) instead of
   * following the Sun; the others keep following.
   */
  const wingManual = new Map();
  const scratchMatrix = new Float64Array(16);

  function bind(model) {
    boundModel = model;
    const get = (joint) => model.getNode(joint.node) ?? null;
    nodes = {
      one: TIANGONG_ONE_AXIS_WINGS.map(get),
      alpha: TIANGONG_TWO_AXIS_WINGS.map((pair) => get(pair.alpha)),
      beta: TIANGONG_TWO_AXIS_WINGS.map((pair) => get(pair.beta)),
      dish: get(TIANGONG_HGA),
      arms: Object.fromEntries(
        Object.entries(TIANGONG_ARMS).map(([key, joints]) => [
          key,
          joints.map(get),
        ]),
      ),
    };
    angles = null;
    dish = null;
  }

  function sunEcef(date) {
    const sun = sunPositionFixed(date.getTime());
    const length = Math.hypot(sun.x, sun.y, sun.z) || 1;
    return [sun.x / length, sun.y / length, sun.z / length];
  }

  function write(node, joint, angle) {
    if (!node) return;
    node.matrix = issAxisMatrix(joint.pivot, joint.axis, angle, scratchMatrix);
  }

  /**
   * @param {{ready: boolean, getNode: (name: string) => object|undefined}} model
   *   A ready model, or any holder of nodes that take a `matrix`.
   * @param {Date} date The instant the model is placed at.
   * @param {{x:number,y:number,z:number}} position Earth-fixed station position.
   * @param {{x:number[], y:number[], z:number[]}} axes Its flight axes.
   * @param {number} [nowMs] Wall clock, for the turn rate.
   */
  function update(model, date, position, axes, nowMs = Date.now()) {
    if (!model.ready) return;
    if (model !== boundModel) bind(model);
    const forced = override?.(nowMs) ?? null;
    if (forced) {
      lastSunlit = Boolean(forced.sunlit);
      targets = tiangongWingTargets(forced.sun, forced.sunlit, targets);
    } else {
      const sun = sunEcef(date);
      const sunlit = !issInShadow([position.x, position.y, position.z], sun);
      lastSunlit = sunlit;
      targets = tiangongWingTargets(
        issSunInModelFrame(sun, axes),
        sunlit,
        targets,
      );
    }
    // A first frame, or one after a pause, goes straight to the pose.
    const elapsed = (nowMs - lastMs) / 1000;
    lastMs = nowMs;
    const maxStep =
      !angles || !(elapsed >= 0) || elapsed > 2
        ? Number.POSITIVE_INFINITY
        : ISS_JOINT_RATE * elapsed;
    // A wing set by hand aims for its set angle; the rest for the Sun's.
    const goalFor = (group, joints) =>
      targets[group].map((target, i) =>
        wingManual.has(joints[i].node)
          ? wingManual.get(joints[i].node)
          : target,
      );
    const goals = {
      one: goalFor('one', TIANGONG_ONE_AXIS_WINGS),
      alpha: goalFor(
        'alpha',
        TIANGONG_TWO_AXIS_WINGS.map((pair) => pair.alpha),
      ),
      beta: goalFor(
        'beta',
        TIANGONG_TWO_AXIS_WINGS.map((pair) => pair.beta),
      ),
    };
    const step = (group) =>
      goals[group].map((target, i) =>
        issStepAngle(angles?.[group][i] ?? 0, target, maxStep),
      );
    const next = { one: step('one'), alpha: step('alpha'), beta: step('beta') };
    TIANGONG_ONE_AXIS_WINGS.forEach((joint, i) => {
      if (!angles || next.one[i] !== angles.one[i])
        write(nodes.one[i], joint, next.one[i]);
    });
    TIANGONG_TWO_AXIS_WINGS.forEach((pair, i) => {
      if (!angles || next.alpha[i] !== angles.alpha[i])
        write(nodes.alpha[i], pair.alpha, next.alpha[i]);
      if (!angles || next.beta[i] !== angles.beta[i])
        write(nodes.beta[i], pair.beta, next.beta[i]);
    });
    angles = next;

    // The dish: the highest relay satellite; one below the station's horizon
    // plane keeps its last aim.
    const current = dish ?? [0, 1, 0];
    const wanted = tiangongRelayDirections(
      [position.x, position.y, position.z],
      axes,
    )[0];
    const target = wanted && wanted[1] >= DISH_MIN_UP ? wanted : current;
    const stepped = issStepDirection(current, target, maxStep);
    if (!dish || stepped.some((c, k) => Math.abs(c - current[k]) > 1e-9))
      if (nodes.dish)
        nodes.dish.matrix = issAimMatrix(
          TIANGONG_HGA.pivot,
          stepped,
          scratchMatrix,
        );
    dish = stepped;

    // Arms: an illustrative sway about the folded pose (see TIANGONG_ARMS).
    for (const [key, joints] of Object.entries(TIANGONG_ARMS)) {
      if (armManual.has(key)) continue;
      const sway = issArmAngles(nowMs / 1000, joints);
      joints.forEach((joint, i) => {
        if (!joint.sway && !joint.centre) return;
        write(nodes.arms[key][i], joint, joint.centre + sway[i]);
      });
    }
  }

  /**
   * STATION section: turn any named node about an axis through a pivot. A
   * node of either arm takes that arm off its sway.
   * @param {string} name
   * @param {number[]} pivot
   * @param {number[]} axis Unit vector.
   * @param {number} angle Radians.
   */
  function setJoint(name, pivot, axis, angle) {
    for (const [key, joints] of Object.entries(TIANGONG_ARMS))
      if (joints.some((joint) => joint.node === name)) armManual.add(key);
    const node = boundModel?.getNode(name);
    if (node) node.matrix = issAxisMatrix(pivot, axis, angle, scratchMatrix);
  }

  /** Forget the model and every manual choice: the next update starts clean. */
  function reset() {
    boundModel = null;
    nodes = null;
    angles = null;
    targets = null;
    dish = null;
    override = null;
    wingManual.clear();
    armManual.clear();
  }

  /**
   * STATION section: a function giving the Sun on the model's axes (and
   * whether the station is lit) in place of the real one, or null for the
   * real one.
   * @param {((nowMs:number)=>{sun:number[], sunlit:boolean}|null)|null} fn
   */
  function setOverride(fn) {
    override = fn;
  }

  /** Whether the station is in sunlight, as of the last update. */
  function isSunlit() {
    return lastSunlit;
  }

  /**
   * STATION section: hand an arm back to its sway; both when no arm is named.
   * @param {'cmm'|'emm'} [key]
   */
  function resumeArm(key) {
    for (const arm of key ? [key] : [...armManual]) {
      if (!armManual.delete(arm)) continue;
      // Joints the sway does not move would keep their manual angle: they go
      // back to the folded pose. The swaying ones are posed again next update.
      for (const joint of TIANGONG_ARMS[arm] ?? []) {
        if (joint.sway || joint.centre) continue;
        const node = boundModel?.getNode(joint.node);
        if (node) node.matrix = undefined;
      }
    }
  }

  /**
   * STATION section: hold one wing joint at an angle, by its node name
   * (a TIANGONG_ONE_AXIS_WINGS entry, or a lab wing's alpha or beta node).
   * The joint turns there at the joint rate on the next updates. Null lets
   * the wing follow the Sun again.
   * @param {string} name
   * @param {number|null} angle Radians.
   */
  function setWingAngle(name, angle) {
    if (angle === null || !Number.isFinite(angle)) wingManual.delete(name);
    else wingManual.set(name, angle);
  }

  /** STATION section: every wing back to the Sun. */
  function resumeWings() {
    wingManual.clear();
  }

  return {
    update,
    reset,
    setOverride,
    setJoint,
    resumeArm,
    setWingAngle,
    resumeWings,
    isSunlit,
    /** No telemetry exists for Tiangong: the angles are always computed. */
    isLive: () => false,
    setTelemetryAllowed() {},
  };
}
