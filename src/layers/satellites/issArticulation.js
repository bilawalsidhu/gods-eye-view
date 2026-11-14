import * as Cesium from 'cesium';

/**
 * The ISS model's moving parts. NASA's file names its joints; the build keeps
 * each one as a node of its own, with the parts it carries beneath it, all in
 * the model's rest frame (glTF axes, meters: X port, Y zenith, Z forward), so
 * a joint turns by rotating its node about `pivot`.
 *
 * The angles are computed from where the Sun is, not read from telemetry: the
 * two alpha joints turn the outboard truss about the truss axis, each array's
 * beta joint turns it about its mast, and the two radiator joints keep the
 * radiators edge-on to the Sun. In the Earth's shadow the arrays feather:
 * masts along the flight direction, edge into it.
 */

/** Alpha joints (SARJ): rotate about the truss, glTF X. */
export const ISS_ALPHA_JOINTS = Object.freeze([
  Object.freeze({ node: 'PORT_ALPHA_ROT', pivot: [19.533, 0, 0] }),
  Object.freeze({ node: 'STBD_ALPHA_ROT', pivot: [-19.533, 0, 0] }),
]);

/**
 * Beta joints (BGA): rotate about the mast, glTF Z at rest. `face` is the
 * sign of the cell side's normal along X at rest (the roll-out arrays sit on
 * that side).
 */
export const ISS_BETA_JOINTS = Object.freeze([
  Object.freeze({
    node: 'PORT_BETA_ROT_2A',
    pivot: [36.7319, 0.7256, -3.0077],
    face: -1,
  }),
  Object.freeze({
    node: 'PORT_BETA_ROT_4A',
    pivot: [36.7319, -0.7258, 2.2332],
    face: -1,
  }),
  Object.freeze({
    node: 'PORT_BETA_ROT_2B',
    pivot: [53.223, -0.7196, 2.2335],
    face: -1,
  }),
  Object.freeze({
    node: 'PORT_BETA_ROT_4B',
    pivot: [53.2219, 0.7294, -3.0076],
    face: -1,
  }),
  Object.freeze({
    node: 'STBD_BETA_ROT_1A',
    pivot: [-36.6608, 0.7257, 3.0224],
    face: 1,
  }),
  Object.freeze({
    node: 'STBD_BETA_ROT_3A',
    pivot: [-36.6608, -0.7257, -2.2408],
    face: 1,
  }),
  Object.freeze({
    node: 'STBD_BETA_ROT_1B',
    pivot: [-53.2219, -0.7294, -2.2408],
    face: 1,
  }),
  Object.freeze({
    node: 'STBD_BETA_ROT_3B',
    pivot: [-53.2232, 0.722, 3.0223],
    face: 1,
  }),
]);

/** Radiator joints (TRRJ): rotate about glTF Z; the panels face Y at rest. */
export const ISS_RADIATOR_JOINTS = Object.freeze([
  Object.freeze({ node: 'PORT_TRRJ_GAMMA_ROT', pivot: [16.1287, 0, -7.4432] }),
  Object.freeze({ node: 'STBD_TRRJ_GAMMA_ROT', pivot: [-16.1287, 0, -7.4432] }),
]);

/** How fast a joint may turn on screen, radians per second of wall time. */
export const ISS_JOINT_RATE = (12 * Math.PI) / 180;

/** Below this the Sun is too close to a joint's axis to steer by it. */
const MIN_STEER = 0.05;
const EARTH_RADIUS_M = 6_371_000;

/** The signed difference b - a, wrapped to (-π, π]. */
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

/**
 * Whether a point is in the Earth's shadow, taken as a cylinder.
 * @param {number[]} positionEcef Meters.
 * @param {number[]} sunEcef Unit vector toward the Sun.
 * @returns {boolean}
 */
export function issInShadow(positionEcef, sunEcef) {
  const along =
    positionEcef[0] * sunEcef[0] +
    positionEcef[1] * sunEcef[1] +
    positionEcef[2] * sunEcef[2];
  if (along >= 0) return false;
  const off = Math.hypot(
    positionEcef[0] - along * sunEcef[0],
    positionEcef[1] - along * sunEcef[1],
    positionEcef[2] - along * sunEcef[2],
  );
  return off < EARTH_RADIUS_M;
}

/**
 * The Sun's direction on the model's glTF axes, from the flight axes the
 * model is oriented by (x along-track, y orbit normal, z zenith).
 * @param {number[]} sunEcef Unit vector toward the Sun, Earth-fixed.
 * @param {{x:number[], y:number[], z:number[]}} axes
 * @returns {number[]} [port, zenith, forward].
 */
export function issSunInModelFrame(sunEcef, axes) {
  const dot = (a) => a[0] * sunEcef[0] + a[1] * sunEcef[1] + a[2] * sunEcef[2];
  return [dot(axes.y), dot(axes.z), dot(axes.x)];
}

/**
 * The joint angles that point the arrays at the Sun.
 * @param {number[]} sun Unit vector toward the Sun on the model's glTF axes.
 * @param {boolean} sunlit False in the Earth's shadow: the arrays feather.
 * @param {{alpha:number, gamma:number}} [previous] The last targets, so a
 *   joint with two equivalent answers keeps the nearer one.
 * @returns {{alpha:number, beta:number[], gamma:number}} Radians: `alpha`
 *   about +X for both alpha joints, `beta` about +Z per ISS_BETA_JOINTS entry,
 *   `gamma` about +Z for both radiator joints.
 */
export function issJointTargets(
  sun,
  sunlit,
  previous = { alpha: 0, gamma: 0 },
) {
  const [sx, sy, sz] = sun;
  // Radiators: the panel normal, Y at rest, perpendicular to the Sun.
  const gamma =
    Math.hypot(sx, sy) < MIN_STEER
      ? previous.gamma
      : nearestHalfTurn(Math.atan2(sy, sx), previous.gamma);
  if (!sunlit) {
    return {
      alpha: nearestHalfTurn(0, previous.alpha),
      beta: ISS_BETA_JOINTS.map(() => 0),
      gamma,
    };
  }
  // Alpha: the masts, ±Z at rest, perpendicular to the Sun.
  const alpha =
    Math.hypot(sy, sz) < MIN_STEER
      ? previous.alpha
      : nearestHalfTurn(Math.atan2(sz, sy), previous.alpha);
  // The Sun as the arrays see it before the alpha turn.
  const c = Math.cos(alpha);
  const s = Math.sin(alpha);
  const lx = sx;
  const ly = c * sy + s * sz;
  // Beta: the cell side's normal, ±X at rest, onto the Sun.
  const beta = ISS_BETA_JOINTS.map(({ face }) =>
    Math.atan2(face * ly, face * lx),
  );
  return { alpha, beta, gamma };
}

/**
 * Step `current` toward `target` the short way round, by at most `maxStep`.
 * @returns {number}
 */
export function issStepAngle(current, target, maxStep) {
  const delta = wrap(target - current);
  if (Math.abs(delta) <= maxStep) return current + delta;
  return current + Math.sign(delta) * maxStep;
}

/**
 * A node's matrix for a turn of `angle` about `axis` ('x' or 'z') through
 * `pivot`, column-major.
 * @param {'x'|'z'} axis
 * @param {number[]} pivot
 * @param {number} angle Radians.
 * @param {Cesium.Matrix4} result
 * @returns {Cesium.Matrix4}
 */
export function issJointMatrix(axis, pivot, angle, result) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const [px, py, pz] = pivot;
  // Row-major arguments.
  if (axis === 'x')
    return set(result, [
      1,
      0,
      0,
      0,
      0,
      c,
      -s,
      py - (c * py - s * pz),
      0,
      s,
      c,
      pz - (s * py + c * pz),
      0,
      0,
      0,
      1,
    ]);
  return set(result, [
    c,
    -s,
    0,
    px - (c * px - s * py),
    s,
    c,
    0,
    py - (s * px + c * py),
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
  ]);
}

function set(result, rowMajor) {
  return Cesium.Matrix4.fromRowMajorArray(rowMajor, result);
}

/**
 * Canadarm2's seven joints as NASA's file names them, base to tip: each
 * node's pivot and its local Z axis on the model's axes. Where the real arm
 * is at any moment is not public, so its motion here is ILLUSTRATIVE: a slow
 * sway of `sway` radians about the pose in NASA's file, over `period`
 * seconds. Joints with no sway stay as filed.
 */
export const ISS_ARM_JOINTS = Object.freeze(
  [
    ['SHR', [0.6732, -9.3793, 8.3367], [-0.0942, -0.0136, 0.9955], 0, 0],
    ['SHY', [0.6004, -9.3899, 9.105], [-0.2949, 0.9554, -0.0148], 8, 97],
    ['SHP_PRIME', [0.7848, -9.9873, 9.1143], [-0.2949, 0.9554, -0.0148], 6, 71],
    [
      'ELP_PRIME',
      [-2.9987, -11.8039, 2.5061],
      [-0.2949, 0.9554, -0.0148],
      12,
      53,
    ],
    ['WRP', [-3.8898, -12.6132, 10.249], [-0.2949, 0.9554, -0.0148], 10, 41],
    ['WRY', [-3.9961, -12.6341, 11.0132], [-0.2949, 0.9554, -0.0148], 0, 0],
    ['WRR', [-4.2995, -12.7285, 10.9684], [0.2874, -0.5533, -0.7818], 0, 0],
  ].map(([node, pivot, axis, swayDeg, period]) =>
    Object.freeze({
      node,
      pivot,
      axis,
      sway: (swayDeg * Math.PI) / 180,
      period,
    }),
  ),
);

/**
 * The station's smaller arms, swayed the same illustrative way: Dextre's two
 * arms (shoulder and elbow pitch each) and the Japanese arm on Kibo
 * (shoulder, elbow and wrist pitch). The European arm on Nauka has no joints
 * in NASA's file, so it stays as filed.
 */
export const ISS_SMALL_ARM_JOINTS = Object.freeze(
  [
    [
      'SPDM_Arm1_SHP',
      [4.3019, -8.7313, 2.9551],
      [-0.5183, -0.8218, -0.2366],
      5,
      61,
    ],
    [
      'SPDM_Arm1_ELP',
      [4.763, -7.9839, 3.1897],
      [0.2256, 0.4303, -0.874],
      7,
      43,
    ],
    [
      'SPDM_Arm2_SHP',
      [1.8182, -9.8753, 5.2105],
      [-0.27, -0.522, -0.8091],
      5,
      67,
    ],
    [
      'SPDM_Arm2_ELP',
      [1.8575, -9.4898, 6.0546],
      [-0.3202, -0.5495, -0.7717],
      7,
      47,
    ],
    ['JEM_SP_ROT', [14.2188, -3.6716, 13.394], [-0.001, 0, -1], 5, 83],
    ['JEM_EP_ROT', [14.2223, 0.6479, 13.394], [-0.0011, 0, -1], 8, 59],
    ['JEM_WP_ROT', [16.4495, -3.0694, 13.3917], [-0.001, 0, -1], 8, 37],
  ].map(([node, pivot, axis, swayDeg, period]) =>
    Object.freeze({
      node,
      pivot,
      axis,
      sway: (swayDeg * Math.PI) / 180,
      period,
    }),
  ),
);

/** Every joint that sways. */
const ISS_SWAY_JOINTS = [...ISS_ARM_JOINTS, ...ISS_SMALL_ARM_JOINTS];

/**
 * The arm's illustrative joint angles at a wall-clock time.
 * @param {number} seconds
 * @returns {number[]} Radians, one per ISS_ARM_JOINTS entry.
 */
export function issArmAngles(seconds, joints = ISS_ARM_JOINTS) {
  return joints.map(({ sway, period }) =>
    sway ? sway * Math.sin((2 * Math.PI * seconds) / period) : 0,
  );
}

/**
 * The two Ku-band dishes on the Z1 truss. NASA's file has them welded into
 * the truss; the build cuts out everything above each gimbal. At rest a dish
 * looks along +Y (zenith).
 */
export const ISS_DISH_JOINTS = Object.freeze([
  Object.freeze({ node: 'SGANT_ROT_1', pivot: [-1.105, 4.5, -4.885] }),
  Object.freeze({ node: 'SGANT_ROT_2', pivot: [4.56, 4.64, -5.235] }),
]);

/**
 * The relay satellites the dishes talk to (NASA's TDRS) sit over the equator
 * at fixed longitudes, so each is a fixed point in the Earth-fixed frame.
 * These are the fleet's nominal slots (Atlantic, Pacific, Indian Ocean), not
 * a live roster: which satellite the station uses at a given moment is not
 * public in real time.
 */
export const ISS_RELAY_LONGITUDES_DEG = Object.freeze([-41, -171, 85]);
const GEOSTATIONARY_RADIUS_M = 42_164_000;
/** A dish does not look below this much above the station's horizon plane. */
const DISH_MIN_UP = 0.15;

/**
 * Where the relay satellites are from the station, on the model's axes, the
 * highest above the station first.
 * @param {number[]} positionEcef Meters.
 * @param {{x:number[], y:number[], z:number[]}} axes Flight axes.
 * @returns {number[][]} Unit vectors [port, zenith, forward].
 */
export function issRelayDirections(positionEcef, axes) {
  return ISS_RELAY_LONGITUDES_DEG.map((longitude) => {
    const lon = (longitude * Math.PI) / 180;
    const to = [
      GEOSTATIONARY_RADIUS_M * Math.cos(lon) - positionEcef[0],
      GEOSTATIONARY_RADIUS_M * Math.sin(lon) - positionEcef[1],
      -positionEcef[2],
    ];
    const length = Math.hypot(to[0], to[1], to[2]);
    return issSunInModelFrame(
      to.map((c) => c / length),
      axes,
    );
  }).sort((a, b) => b[1] - a[1]);
}

/**
 * Turn the unit vector `current` toward `target` by at most `maxStep` radians.
 * @returns {number[]}
 */
export function issStepDirection(current, target, maxStep) {
  const cos = Math.min(
    1,
    Math.max(
      -1,
      current[0] * target[0] + current[1] * target[1] + current[2] * target[2],
    ),
  );
  const angle = Math.acos(cos);
  if (angle <= maxStep || angle < 1e-6) return target;
  const sin = Math.sin(angle);
  // Opposite vectors have no single arc between them: nudge off the line.
  if (sin < 1e-6)
    return issStepDirection(
      [current[2], current[0], current[1]],
      target,
      maxStep,
    );
  const t = maxStep / angle;
  const a = Math.sin((1 - t) * angle) / sin;
  const b = Math.sin(t * angle) / sin;
  return [0, 1, 2].map((i) => a * current[i] + b * target[i]);
}

/**
 * A node's matrix for a turn of `angle` about the unit vector `axis` through
 * `pivot`.
 * @param {number[]} pivot
 * @param {number[]} axis Unit vector.
 * @param {number} angle Radians.
 * @param {Cesium.Matrix4} result
 * @returns {Cesium.Matrix4}
 */
export function issAxisMatrix(pivot, axis, angle, result) {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const r = [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
  const rows = r.map((row, i) => [
    ...row,
    pivot[i] - (row[0] * pivot[0] + row[1] * pivot[1] + row[2] * pivot[2]),
  ]);
  return set(result, [...rows[0], ...rows[1], ...rows[2], 0, 0, 0, 1]);
}

/**
 * A dish node's matrix that turns its rest boresight (+Y) onto `direction`.
 * @param {number[]} pivot
 * @param {number[]} direction Unit vector on the model's axes.
 * @param {Cesium.Matrix4} result
 * @returns {Cesium.Matrix4}
 */
export function issAimMatrix(pivot, direction, result) {
  // Y × direction
  const kx = direction[2];
  const kz = -direction[0];
  const length = Math.hypot(kx, kz);
  if (length < 1e-9)
    return issAxisMatrix(
      pivot,
      [1, 0, 0],
      direction[1] > 0 ? 0 : Math.PI,
      result,
    );
  const angle = Math.acos(Math.min(1, Math.max(-1, direction[1])));
  return issAxisMatrix(pivot, [kx / length, 0, kz / length], angle, result);
}

/**
 * Drives the loaded model's joints. Stateless about the model: `update` looks
 * the nodes up once per model and only writes a node whose angle moved.
 */
export function createIssArticulation() {
  let boundModel = null;
  let nodes = null;
  let angles = null;
  let targets = { alpha: 0, gamma: 0 };
  let lastMs = 0;
  let override = null;
  let dishOverride = null;
  /** Whether the last update had the station in sunlight; null before one. */
  let lastSunlit = null;
  /** Command panel state: the arm is being posed by hand, so the sway is off. */
  let armManual = false;
  let armNodes = null;
  /** Command panel state: how far the arrays are rolled out, 0.05 to 1. */
  let deploy = 1;
  let deployTarget = 1;
  let radiatorDeploy = 1;
  let radiatorTarget = 1;
  /** The truss face the radiators fold back to, on the model's Z axis. */
  const RADIATOR_ROOT_Z = -1.9;
  /** The power modules' radiators, cut out by the build, and their root. */
  const SMALL_RADIATOR_NODES = [
    'PVR_FOLD_P4',
    'PVR_FOLD_P6',
    'PVR_FOLD_S4',
    'PVR_FOLD_S6',
  ];
  const SMALL_RADIATOR_ROOT_Y = -1.6;
  /** Where each dish looks now, on the model's axes. */
  let dishes = null;
  const scratchJulian = new Cesium.JulianDate();
  const scratchSun = new Cesium.Cartesian3();
  const scratchToFixed = new Cesium.Matrix3();
  const scratchMatrix = new Cesium.Matrix4();

  function bind(model) {
    boundModel = model;
    const get = (joint) => model.getNode(joint.node) ?? null;
    nodes = {
      alpha: ISS_ALPHA_JOINTS.map(get),
      beta: ISS_BETA_JOINTS.map(get),
      gamma: ISS_RADIATOR_JOINTS.map(get),
      dish: ISS_DISH_JOINTS.map(get),
    };
    angles = null;
    dishes = null;
    armNodes = null;
  }

  function sunEcef(date) {
    const julian = Cesium.JulianDate.fromDate(date, scratchJulian);
    const inertial =
      Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        julian,
        scratchSun,
      );
    const toFixed =
      Cesium.Transforms.computeIcrfToFixedMatrix(julian, scratchToFixed) ??
      Cesium.Transforms.computeTemeToPseudoFixedMatrix(julian, scratchToFixed);
    Cesium.Matrix3.multiplyByVector(toFixed, inertial, scratchSun);
    Cesium.Cartesian3.normalize(scratchSun, scratchSun);
    return [scratchSun.x, scratchSun.y, scratchSun.z];
  }

  function write(node, axis, pivot, angle) {
    if (!node) return;
    node.matrix = issJointMatrix(axis, pivot, angle, scratchMatrix);
  }

  /**
   * @param {Cesium.Model} model A ready model.
   * @param {Date} date The instant the model is placed at.
   * @param {Cesium.Cartesian3} position Earth-fixed station position.
   * @param {{x:number[], y:number[], z:number[]}} axes Its flight axes.
   * @param {number} [nowMs] Wall clock, for the turn rate.
   */
  function update(model, date, position, axes, nowMs = Date.now()) {
    if (!model.ready) return;
    if (model !== boundModel) bind(model);
    const forced = override?.(nowMs) ?? null;
    if (forced) {
      lastSunlit = Boolean(forced.sunlit);
      targets = issJointTargets(forced.sun, forced.sunlit, targets);
    } else {
      const sun = sunEcef(date);
      const sunlit = !issInShadow([position.x, position.y, position.z], sun);
      lastSunlit = sunlit;
      targets = issJointTargets(issSunInModelFrame(sun, axes), sunlit, targets);
    }
    // A first frame, or one after a pause, goes straight to the pose.
    const elapsed = (nowMs - lastMs) / 1000;
    lastMs = nowMs;
    const maxStep =
      !angles || !(elapsed >= 0) || elapsed > 2
        ? Number.POSITIVE_INFINITY
        : ISS_JOINT_RATE * elapsed;
    const next = {
      alpha: issStepAngle(angles?.alpha ?? 0, targets.alpha, maxStep),
      beta: targets.beta.map((target, i) =>
        issStepAngle(angles?.beta[i] ?? 0, target, maxStep),
      ),
      gamma: issStepAngle(angles?.gamma ?? 0, targets.gamma, maxStep),
    };
    if (!angles || next.alpha !== angles.alpha)
      ISS_ALPHA_JOINTS.forEach((joint, i) =>
        write(nodes.alpha[i], 'x', joint.pivot, next.alpha),
      );
    // Command panel: squash the arrays along their masts (see setDeploy).
    const deployStep = Number.isFinite(maxStep) ? elapsed / 8 : 1;
    const nextDeploy =
      deploy +
      Math.sign(deployTarget - deploy) *
        Math.min(Math.abs(deployTarget - deploy), deployStep);
    ISS_BETA_JOINTS.forEach((joint, i) => {
      if (
        !angles ||
        next.beta[i] !== angles.beta[i] ||
        nextDeploy !== deploy ||
        nextDeploy !== 1
      ) {
        const node = nodes.beta[i];
        if (!node) return;
        const m = issJointMatrix('z', joint.pivot, next.beta[i], scratchMatrix);
        m[10] = nextDeploy;
        m[14] = joint.pivot[2] * (1 - nextDeploy);
        node.matrix = m;
      }
    });
    deploy = nextDeploy;
    // Command panel: fold the radiators toward the truss.
    const nextRadiator =
      radiatorDeploy +
      Math.sign(radiatorTarget - radiatorDeploy) *
        Math.min(Math.abs(radiatorTarget - radiatorDeploy), deployStep);
    if (
      !angles ||
      next.gamma !== angles.gamma ||
      nextRadiator !== radiatorDeploy
    )
      ISS_RADIATOR_JOINTS.forEach((joint, i) => {
        const node = nodes.gamma[i];
        if (!node) return;
        const m = issJointMatrix('z', joint.pivot, next.gamma, scratchMatrix);
        m[10] = nextRadiator;
        m[14] = RADIATOR_ROOT_Z * (1 - nextRadiator);
        node.matrix = m;
      });
    // The four small radiators fold up to the truss, along Y.
    if (nextRadiator !== radiatorDeploy)
      for (const name of SMALL_RADIATOR_NODES) {
        const node = model.getNode(name);
        if (!node) continue;
        node.matrix = Cesium.Matrix4.fromRowMajorArray(
          [
            1,
            0,
            0,
            0,
            0,
            nextRadiator,
            0,
            SMALL_RADIATOR_ROOT_Y * (1 - nextRadiator),
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
          ],
          scratchMatrix,
        );
      }
    radiatorDeploy = nextRadiator;
    angles = next;

    // Dishes: the highest relay satellite for the first, the next for the
    // second; one below the station's horizon plane keeps its last aim.
    const relays = dishOverride
      ? [dishOverride, dishOverride]
      : issRelayDirections([position.x, position.y, position.z], axes);
    const nextDishes = ISS_DISH_JOINTS.map((joint, i) => {
      const current = dishes?.[i] ?? [0, 1, 0];
      const wanted = relays[i];
      const target = wanted && wanted[1] >= DISH_MIN_UP ? wanted : current;
      const stepped = issStepDirection(current, target, maxStep);
      const moved =
        !dishes || stepped.some((c, k) => Math.abs(c - current[k]) > 1e-9);
      if (moved)
        if (nodes.dish[i])
          nodes.dish[i].matrix = issAimMatrix(
            joint.pivot,
            stepped,
            scratchMatrix,
          );
      return stepped;
    });
    dishes = nextDishes;

    // Arm: an illustrative sway (see ISS_ARM_JOINTS).
    if (!armManual) {
      const arm = issArmAngles(nowMs / 1000, ISS_SWAY_JOINTS);
      ISS_SWAY_JOINTS.forEach((joint, i) => {
        if (!joint.sway) return;
        const node = (armNodes ??= ISS_SWAY_JOINTS.map(
          (entry) => model.getNode(entry.node) ?? null,
        ))[i];
        if (node)
          node.matrix = issAxisMatrix(
            joint.pivot,
            joint.axis,
            arm[i],
            scratchMatrix,
          );
      });
    }
  }

  /**
   * Command panel: turn any named node about an axis through a pivot.
   * @param {string} name
   * @param {number[]} pivot
   * @param {number[]} axis Unit vector.
   * @param {number} angle Radians.
   */
  function setJoint(name, pivot, axis, angle) {
    armManual = true;
    const node = boundModel?.getNode(name);
    if (node) node.matrix = issAxisMatrix(pivot, axis, angle, scratchMatrix);
  }

  function reset() {
    boundModel = null;
    nodes = null;
    angles = null;
    dishes = null;
    armNodes = null;
    targets = { alpha: 0, gamma: 0 };
  }

  /**
   * Command panel: a function giving the Sun on the model's axes (and whether the
   * station is lit) in place of the real one, or null for the real one.
   * @param {((nowMs:number)=>{sun:number[], sunlit:boolean}|null)|null} fn
   */
  function setOverride(fn) {
    override = fn;
  }

  /** Whether the station is in sunlight, as of the last update. */
  function isSunlit() {
    return lastSunlit;
  }

  /** Command panel: aim both dishes along a unit vector, or null for the relays. */
  function setDishOverride(direction) {
    dishOverride = direction;
  }

  /**
   * Command panel: squash the arrays toward their bases, or let them
   * out again. The real arrays do not retract in service.
   * @param {boolean} out
   */
  function setDeploy(out) {
    deployTarget = out ? 1 : 0.05;
  }

  /**
   * Command panel: fold the radiators toward the truss, or let them
   * out. The real ones are accordion panels that can do this, but stay out
   * in service.
   * @param {boolean} out
   */
  function setRadiatorDeploy(out) {
    radiatorTarget = out ? 1 : 0.08;
  }

  /** Command panel: hand the arm back to its sway. */
  function resumeArm() {
    armManual = false;
  }

  return {
    update,
    reset,
    setOverride,
    setDishOverride,
    setJoint,
    resumeArm,
    setDeploy,
    setRadiatorDeploy,
    isSunlit,
  };
}
