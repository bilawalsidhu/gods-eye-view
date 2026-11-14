/**
 * Phone "Point at the sky" maths (pure, no DOM; item 2).
 *
 * Frames
 *  - Earth frame: East-North-Up (x east, y north, z up), the frame the sky
 *    view's az/el live in (skyMath.js).
 *  - Device frame (W3C Device Orientation): x to the right of the screen and
 *    y to its top in the device's NATURAL (portrait) orientation, z out of
 *    the screen towards the user.
 *  - A quaternion [x, y, z, w] rotates device vectors into the Earth frame:
 *    the W3C DeviceOrientation Euler angles give q = Rz(alpha) Rx(beta)
 *    Ry(gamma) (intrinsic Z-X'-Y''), and the Generic Sensor
 *    AbsoluteOrientationSensor.quaternion is the same rotation directly.
 *
 * The view looks OUT OF THE BACK of the phone (device -z), like a camera:
 * hold the phone up and the screen shows the sky behind it. With the phone
 * flat and its back to the sky (held overhead, screen down) the view is the
 * zenith; lying screen-up on a table it looks at the ground (nadir).
 * The screen's right/up are the device axes turned by screen.orientation
 * .angle (0 portrait, 90 landscape with the top to the left, 270 top to the
 * right, 180 upside down), so landscape needs no special case.
 */
import { DEG, azElFromEnu, normalizeAz } from './skyMath.js';

// ── quaternions [x, y, z, w] ───────────────────────────────────────────────
export const QUAT_IDENTITY = Object.freeze([0, 0, 0, 1]);

export function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(n > 0) || !Number.isFinite(n)) return [...QUAT_IDENTITY];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotation of `deg` degrees about a unit axis (right-handed). */
export function quatAxisAngle([ax, ay, az], deg) {
  const h = (deg * DEG) / 2;
  const s = Math.sin(h);
  return [ax * s, ay * s, az * s, Math.cos(h)];
}

/** W3C DeviceOrientation alpha/beta/gamma (degrees) -> device-to-Earth quaternion. */
export function quatFromEuler(alphaDeg, betaDeg, gammaDeg) {
  const qz = quatAxisAngle([0, 0, 1], Number(alphaDeg) || 0);
  const qx = quatAxisAngle([1, 0, 0], Number(betaDeg) || 0);
  const qy = quatAxisAngle([0, 1, 0], Number(gammaDeg) || 0);
  return quatNormalize(quatMultiply(quatMultiply(qz, qx), qy));
}

/** Rotate a 3-vector by a unit quaternion. */
export function rotateVector(q, v) {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v); v' = v + w t + cross(q.xyz, t)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/**
 * Quaternion whose rotation maps the device x/y/z axes onto the given
 * (orthonormal, right-handed) Earth-frame vectors. Used by tests to state a
 * physical pose ("back to the east, top up") without Euler angles.
 */
export function quatFromAxes(xAxis, yAxis, zAxis) {
  const m00 = xAxis[0];
  const m10 = xAxis[1];
  const m20 = xAxis[2];
  const m01 = yAxis[0];
  const m11 = yAxis[1];
  const m21 = yAxis[2];
  const m02 = zAxis[0];
  const m12 = zAxis[1];
  const m22 = zAxis[2];
  const trace = m00 + m11 + m22;
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

export const quatDot = (a, b) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

/** Rotation angle (degrees) between two orientations. */
export function quatAngleDeg(a, b) {
  const d = Math.min(1, Math.abs(quatDot(a, b)));
  return (2 * Math.acos(d)) / DEG;
}

/** Spherical linear interpolation, shortest path, t in [0, 1]. */
export function slerp(a, b, t) {
  let bb = b;
  let cos = quatDot(a, b);
  if (cos < 0) {
    bb = b.map((v) => -v);
    cos = -cos;
  }
  if (cos > 0.9995) {
    return quatNormalize(a.map((v, i) => v + (bb[i] - v) * t));
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return a.map((v, i) => v * wa + bb[i] * wb);
}

// ── headings ───────────────────────────────────────────────────────────────
/** Wrap degrees to (-180, 180]. */
export function wrap180(deg) {
  let v = Number(deg) % 360;
  if (v <= -180) v += 360;
  if (v > 180) v -= 360;
  return v;
}

/**
 * Turn an orientation so every azimuth grows by `deg` (clockwise seen from
 * above): magnetic -> true with deg = declination, plus the user's Align
 * offset. A clockwise turn about Up is a rotation of -deg about +z.
 */
export function addHeading(q, deg) {
  if (!deg) return q;
  return quatNormalize(quatMultiply(quatAxisAngle([0, 0, 1], -deg), q));
}

/** Compass bearing (deg clockwise from north) and horizontal length of an ENU vector. */
export function bearingOf([e, n]) {
  return {
    bearingDeg: normalizeAz(Math.atan2(e, n) / DEG),
    horizontal: Math.hypot(e, n),
  };
}

const BACK = [0, 0, -1];
const TOP = [0, 1, 0];
/** Below this horizontal length a direction's bearing is too unstable. */
export const MIN_HORIZONTAL = 0.35;
/** The back and the top must agree this well for an iOS compass reading. */
export const MAX_REFERENCE_DISAGREEMENT_DEG = 15;

/**
 * iOS gives orientation (alpha/beta/gamma) in an ARBITRARY yaw frame plus a
 * separate magnetic compass heading (webkitCompassHeading). Which device
 * direction that heading belongs to is only certain in two poses: flat with
 * the screen up (the top edge, like a hand compass) and upright in portrait
 * (the back, like the Compass app held up). Tilted back past vertical the
 * back and the top point opposite ways (and in landscape 90 deg apart), so
 * no correction is taken there: the gyro-stable relative yaw keeps the last
 * correction while the user looks up. (Apple's exact reference vector is
 * UNVERIFIED; the device test script checks it, and Align fixes any
 * remaining constant offset.)
 * Returns the degrees to pass to addHeading(qRelative, ...), or null.
 */
export function compassYawCorrection(qRelative, compassHeadingDeg) {
  if (!Number.isFinite(compassHeadingDeg)) return null;
  const backVec = rotateVector(qRelative, BACK);
  const back = bearingOf(backVec);
  const top = bearingOf(rotateVector(qRelative, TOP));
  let reference = null;
  if (back.horizontal >= MIN_HORIZONTAL) {
    // upright-ish: the back carries the heading unless the top has a
    // bearing of its own that disagrees (tilted back, or landscape)
    if (
      top.horizontal < MIN_HORIZONTAL ||
      Math.abs(wrap180(back.bearingDeg - top.bearingDeg)) <=
        MAX_REFERENCE_DISAGREEMENT_DEG
    )
      reference = back;
  } else if (backVec[2] < 0 && top.horizontal >= MIN_HORIZONTAL) {
    // flat, screen up: the top edge carries the heading
    reference = top;
  }
  if (!reference) return null;
  return wrap180(compassHeadingDeg - reference.bearingDeg);
}

/** Exponential smoothing of an angle (degrees) the short way round. */
export function smoothAngleDeg(previous, next, k) {
  if (!Number.isFinite(previous)) return wrap180(next);
  return wrap180(previous + wrap180(next - previous) * k);
}

// ── the view ───────────────────────────────────────────────────────────────
/** screen.orientation.angle (or legacy window.orientation) -> 0/90/180/270. */
export function normalizeScreenAngle(angle) {
  const v = Number(angle);
  if (!Number.isFinite(v)) return 0;
  return (((Math.round(v / 90) * 90) % 360) + 360) % 360;
}

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Screen basis in ENU for a device orientation and screen rotation:
 * forward = out of the back, right/up = the screen's right/up as drawn.
 */
export function screenBasis(q, screenAngleDeg = 0) {
  const t = normalizeScreenAngle(screenAngleDeg) * DEG;
  const c = Math.cos(t);
  const s = Math.sin(t);
  // device-frame screen axes after the content is turned by `t`
  const rightDevice = [c, -s, 0];
  const upDevice = [s, c, 0];
  return {
    forward: rotateVector(q, BACK),
    right: rotateVector(q, rightDevice),
    up: rotateVector(q, upDevice),
  };
}

/**
 * Sky view angles { azDeg, elDeg, rollDeg } for a device orientation, chosen
 * so skyMath.cameraBasis(view) reproduces the screen basis exactly (same
 * roll sign as the overlay projection and Cesium's camera roll).
 */
export function viewFromQuaternion(q, screenAngleDeg = 0) {
  const { forward, right } = screenBasis(q, screenAngleDeg);
  let { azDeg, elDeg } = azElFromEnu(forward);
  if (Math.hypot(forward[0], forward[1]) < 1e-6) {
    // straight up/down: take the azimuth from the screen's top edge so the
    // roll stays small and continuous (any azimuth is exact with its roll)
    const up = rotateVector(q, screenBasisUp(screenAngleDeg));
    azDeg = normalizeAz(Math.atan2(-up[0], -up[1]) / DEG);
    if (forward[2] < 0) azDeg = normalizeAz(azDeg + 180);
  }
  const az = azDeg * DEG;
  const right0 = [Math.cos(az), -Math.sin(az), 0];
  const f0 = [
    Math.cos(elDeg * DEG) * Math.sin(az),
    Math.cos(elDeg * DEG) * Math.cos(az),
    Math.sin(elDeg * DEG),
  ];
  const up0 = cross(right0, f0);
  const rollDeg = Math.atan2(-dot(right, up0), dot(right, right0)) / DEG;
  return { azDeg, elDeg, rollDeg };
}
const screenBasisUp = (angleDeg) => {
  const t = normalizeScreenAngle(angleDeg) * DEG;
  return [Math.sin(t), Math.cos(t), 0];
};

// ── smoothing and battery policy ───────────────────────────────────────────
/** Smoothing weight per 1/30 s sample. */
export const SMOOTH_ALPHA = 0.15;
export const SENSOR_HZ = 30;
const SAMPLE_MS = 1000 / SENSOR_HZ;

/**
 * Frame-rate independent slerp weight: alpha per 1/30 s, so the response
 * time is the same whether frames come at 30, 60 or 120 Hz. A 90 deg step
 * is within 0.7 deg after 1 s and never overshoots (weights are in [0, 1]).
 */
export function smoothingWeight(dtMs, alpha = SMOOTH_ALPHA) {
  if (!(dtMs > 0)) return 0;
  return 1 - Math.pow(1 - alpha, dtMs / SAMPLE_MS);
}

/** One smoothing step from the shown orientation towards the target. */
export function smoothStep(shown, target, dtMs, alpha = SMOOTH_ALPHA) {
  if (!shown) return target;
  return quatNormalize(slerp(shown, target, smoothingWeight(dtMs, alpha)));
}

/**
 * Sensor sample limiter: accepts at most `hz` samples per second on average
 * (browsers fire deviceorientation at 60 Hz or more).
 */
export function createRateLimiter(hz = SENSOR_HZ) {
  const period = 1000 / hz;
  let next = -Infinity;
  return {
    accept(t) {
      if (t < next) return false;
      next = t - next > period ? t + period : next + period;
      return true;
    },
    reset() {
      next = -Infinity;
    },
  };
}

/** Redraw caps while following the phone. */
export const MOVING_FPS = 30;
export const STILL_FPS = 5;
/** A view change below this (degrees) is not drawn at all. */
export const MIN_CHANGE_DEG = 0.01;
/** A change of at least this much per frame counts as "moving". */
export const MOVING_CHANGE_DEG = 0.15;

/**
 * Should this frame apply the smoothed orientation to the camera/overlay?
 * deltaDeg = rotation since the last applied view, sinceMs = time since it.
 * Moving: up to 30 fps. Still (sub-pixel jitter): up to 5 fps. Nothing new:
 * no redraw.
 */
export function shouldApplyFrame(deltaDeg, sinceMs) {
  if (!(deltaDeg >= MIN_CHANGE_DEG)) return false;
  const fps = deltaDeg >= MOVING_CHANGE_DEG ? MOVING_FPS : STILL_FPS;
  return sinceMs >= 1000 / fps - 1;
}

// ── states and messages ────────────────────────────────────────────────────
export const ORIENTATION_STATES = Object.freeze([
  'off',
  'asking',
  'on',
  'unsupported',
  'denied',
  'insecure',
  'calibrating',
]);

/** The status-line text for a state (and calibrating reason). */
export function orientationMessage(state, reason) {
  switch (state) {
    case 'asking':
      return 'Allow motion and orientation access to point at the sky...';
    case 'on':
      return 'Hold the phone up: the view follows where its back points. Drag pauses it.';
    case 'calibrating':
      if (reason === 'relative')
        return 'This browser gives no compass heading. Point the centre at the Sun or Moon and tap Align.';
      if (reason === 'heading')
        return 'Reading the compass: hold the phone upright in portrait for a moment.';
      return 'Compass needs calibrating: wave the phone in a figure 8 a few times, away from metal and cars.';
    case 'unsupported':
      return 'No orientation sensor found in this browser or device. Drag to look around.';
    case 'denied':
      return 'Motion access is blocked. iPhone: close this tab, open the page again and tap Allow. Android Chrome: lock icon > Permissions > Motion sensors. Drag still works.';
    case 'insecure':
      return "Pointing needs a secure https:// address (this http:// address cannot read the phone's sensors). Drag to look around.";
    default:
      return '';
  }
}

/** iOS webkitCompassAccuracy: negative = uncalibrated, > 25 deg = poor. */
export const POOR_ACCURACY_DEG = 25;
export function compassAccuracyPoor(accuracyDeg) {
  if (accuracyDeg == null || !Number.isFinite(Number(accuracyDeg)))
    return false;
  const v = Number(accuracyDeg);
  return v < 0 || v > POOR_ACCURACY_DEG;
}

/** Align offset change that puts the target at the view centre's azimuth. */
export function alignDelta(targetAzDeg, viewAzDeg) {
  return wrap180(targetAzDeg - viewAzDeg);
}

/** Align is refused near the zenith, where azimuth is ill-defined. */
export const ALIGN_MAX_EL_DEG = 75;
/** And when the centre is clearly not on the target. */
export const ALIGN_MAX_MISS_EL_DEG = 15;
