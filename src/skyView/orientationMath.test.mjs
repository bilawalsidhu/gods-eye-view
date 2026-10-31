import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraBasis, projectAzEl } from './skyMath.js';
import {
  addHeading,
  alignDelta,
  compassAccuracyPoor,
  compassYawCorrection,
  createRateLimiter,
  normalizeScreenAngle,
  ORIENTATION_STATES,
  orientationMessage,
  quatAngleDeg,
  quatAxisAngle,
  quatFromAxes,
  quatFromEuler,
  quatMultiply,
  rotateVector,
  screenBasis,
  shouldApplyFrame,
  smoothStep,
  smoothingWeight,
  viewFromQuaternion,
  wrap180,
} from './orientationMath.js';

const DEG = Math.PI / 180;
const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const azClose = (a, b, tol, msg) =>
  assert.ok(Math.abs(wrap180(a - b)) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const vecClose = (a, b, tol, msg) =>
  a.forEach((v, i) => close(v, b[i], tol, `${msg ?? ''}[${i}]`));

const E = [1, 0, 0];
const W = [-1, 0, 0];
const N = [0, 1, 0];
const S = [0, -1, 0];
const UP = [0, 0, 1];
const DOWN = [0, 0, -1];

// W3C Device Orientation: R = Rz(alpha) Rx(beta) Ry(gamma), written out.
function specMatrix(a, b, g) {
  const [ca, sa, cb, sb, cg, sg] = [
    Math.cos(a * DEG),
    Math.sin(a * DEG),
    Math.cos(b * DEG),
    Math.sin(b * DEG),
    Math.cos(g * DEG),
    Math.sin(g * DEG),
  ];
  return [
    [ca * cg - sa * sb * sg, -cb * sa, ca * sg + cg * sa * sb],
    [cg * sa + ca * sb * sg, ca * cb, sa * sg - ca * cg * sb],
    [-cb * sg, sb, cb * cg],
  ];
}
const mul = (m, v) =>
  m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);

test('Euler alpha/beta/gamma -> quaternion equals the W3C rotation matrix Rz Rx Ry', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 200; i += 1) {
    const a = rnd() * 360;
    const b = rnd() * 360 - 180;
    const g = rnd() * 180 - 90;
    const q = quatFromEuler(a, b, g);
    const m = specMatrix(a, b, g);
    for (const v of [E, N, UP, [0.3, -0.5, 0.81]])
      vecClose(rotateVector(q, v), mul(m, v), 1e-12, `a${a} b${b} g${g}`);
  }
});

test('ACCEPT: phone upright (portrait) facing 90 deg true -> az 90, el 0, roll 0', () => {
  // W3C: compass heading = 360 - alpha for an upright phone, so east = 270
  const fromEuler = viewFromQuaternion(quatFromEuler(270, 90, 0), 0);
  close(fromEuler.azDeg, 90, 1e-9, 'az');
  close(fromEuler.elDeg, 0, 1e-9, 'el');
  close(fromEuler.rollDeg, 0, 1e-9, 'roll');
  // the same pose stated physically: back to the east, top up, right side south
  const pose = quatFromAxes(S, UP, W);
  const v = viewFromQuaternion(pose, 0);
  close(v.azDeg, 90, 1e-9);
  close(v.elDeg, 0, 1e-9);
  close(v.rollDeg, 0, 1e-9);
});

test('ACCEPT: flat with its back to the sky (held overhead, screen down) -> el 90; flat screen-up on a table looks at the ground', () => {
  const overhead = viewFromQuaternion(quatFromEuler(180, 180, 0), 0);
  close(overhead.elDeg, 90, 1e-9, 'zenith');
  const overheadAxes = viewFromQuaternion(quatFromAxes(W, N, DOWN), 0);
  close(overheadAxes.elDeg, 90, 1e-9);
  const table = viewFromQuaternion(quatFromEuler(0, 0, 0), 0);
  close(table.elDeg, -90, 1e-9, 'nadir');
});

test('ACCEPT: landscape left (screen angle 90) and right (270) facing east -> az 90, el 0, roll 0; without the screen angle the roll would be 90', () => {
  // top of the phone to the LEFT (north when facing east): x up, y north, z west
  const left = quatFromAxes(UP, N, W);
  const vl = viewFromQuaternion(left, 90);
  close(vl.azDeg, 90, 1e-9, 'left az');
  close(vl.elDeg, 0, 1e-9, 'left el');
  close(vl.rollDeg, 0, 1e-9, 'left roll');
  close(Math.abs(viewFromQuaternion(left, 0).rollDeg), 90, 1e-9);
  // top to the RIGHT (south): x down, y south, z west
  const right = quatFromAxes(DOWN, S, W);
  const vr = viewFromQuaternion(right, 270);
  close(vr.azDeg, 90, 1e-9, 'right az');
  close(vr.elDeg, 0, 1e-9, 'right el');
  close(vr.rollDeg, 0, 1e-9, 'right roll');
  // -90 (some browsers) is the same as 270
  assert.deepEqual(viewFromQuaternion(right, -90), vr);
  assert.equal(normalizeScreenAngle(-90), 270);
  assert.equal(normalizeScreenAngle(undefined), 0);
  assert.equal(normalizeScreenAngle(180), 180);
});

test('view angles reproduce the screen basis exactly through skyMath.cameraBasis (the overlay/Cesium camera), any pose, all four screen rotations', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 400; i += 1) {
    const q = quatFromEuler(rnd() * 360, rnd() * 160 + 10, rnd() * 120 - 60);
    for (const angle of [0, 90, 180, 270]) {
      const view = viewFromQuaternion(q, angle);
      if (view.elDeg < -10 || view.elDeg > 89.9) continue; // clamped range
      const basis = screenBasis(q, angle);
      const cam = cameraBasis({ ...view, fovDeg: 60 });
      vecClose(cam.forward, basis.forward, 1e-9, `fwd ${i}/${angle}`);
      vecClose(cam.right, basis.right, 1e-9, `right ${i}/${angle}`);
      vecClose(cam.up, basis.up, 1e-9, `up ${i}/${angle}`);
    }
  }
});

test('a star seen through the phone lands on the right pixel: direction through screen point (0.4, -0.25) projects there', () => {
  const q = quatFromEuler(200, 70, 25);
  const view = { ...viewFromQuaternion(q, 90), fovDeg: 60 };
  const w = 900;
  const h = 400;
  const tx = Math.tan(30 * DEG);
  const ty = tx / (w / h);
  const { forward, right, up } = screenBasis(q, 90);
  const d = forward.map((f, i) => f + 0.4 * tx * right[i] - 0.25 * ty * up[i]);
  const n = Math.hypot(...d);
  const az = Math.atan2(d[0], d[1]) / DEG;
  const el = Math.asin(d[2] / n) / DEG;
  const p = projectAzEl(az, el, view, w, h);
  close(p.x, ((0.4 + 1) / 2) * w, 1e-6, 'x');
  close(p.y, ((1 + 0.25) / 2) * h, 1e-6, 'y');
});

test('ACCEPT: declination applied: magnetic 270 at +2 deg E -> true 272 (heading turn keeps elevation and roll)', () => {
  // upright portrait facing magnetic 270 (west): alpha = 360 - 270
  const magnetic = quatFromEuler(90, 90, 0);
  close(viewFromQuaternion(magnetic).azDeg, 270, 1e-9);
  const trueQ = addHeading(magnetic, 2);
  const v = viewFromQuaternion(trueQ);
  close(v.azDeg, 272, 1e-9, 'true az');
  close(v.elDeg, 0, 1e-9);
  close(v.rollDeg, 0, 1e-9);
  // tilted and rolled: only the azimuth moves
  const tilted = quatFromEuler(90, 130, 20);
  const a = viewFromQuaternion(tilted);
  const b = viewFromQuaternion(addHeading(tilted, -12.5));
  azClose(b.azDeg, a.azDeg - 12.5, 1e-9);
  close(b.elDeg, a.elDeg, 1e-9);
  close(b.rollDeg, a.rollDeg, 1e-9);
});

test('ACCEPT: smoothing converges in < 1 s without overshoot (90 deg turn, 60 fps frames), frame-rate independent', () => {
  const from = quatFromEuler(270, 90, 0); // east
  const to = quatFromEuler(180, 90, 0); // south
  const run = (fps) => {
    let shown = from;
    let previous = quatAngleDeg(shown, to);
    const errors = [];
    let lastAz = viewFromQuaternion(shown).azDeg;
    for (let k = 0; k < fps; k += 1) {
      shown = smoothStep(shown, to, 1000 / fps);
      const err = quatAngleDeg(shown, to);
      assert.ok(err <= previous + 1e-9, 'monotone (no overshoot)');
      const az = viewFromQuaternion(shown).azDeg;
      assert.ok(
        az >= lastAz - 1e-9 && az <= 180 + 1e-9,
        `az ${az} never passes 180`,
      );
      lastAz = az;
      previous = err;
      errors.push(err);
    }
    return errors.at(-1);
  };
  const at60 = run(60);
  assert.ok(at60 < 1, `after 1 s ${at60} deg left`);
  const at30 = run(30);
  const at120 = run(120);
  close(at30, at60, 0.01);
  close(at120, at60, 0.01);
  // 0.15 per 1/30 s sample, and nothing for dt <= 0
  close(smoothingWeight(1000 / 30), 0.15, 1e-12);
  assert.equal(smoothingWeight(0), 0);
  assert.equal(smoothStep(null, to, 16), to);
});

test('battery: sensor samples limited to <= 30 Hz; redraw at <= 30 fps moving, <= 5 fps still, none without change', () => {
  for (const hz of [60, 100, 120]) {
    const limiter = createRateLimiter(30);
    let accepted = 0;
    for (let t = 0; t < 10_000; t += 1000 / hz)
      if (limiter.accept(t)) accepted += 1;
    assert.ok(accepted <= 301 && accepted >= 290, `${hz} Hz -> ${accepted}`);
  }
  const slow = createRateLimiter(30);
  let all = 0;
  for (let t = 0; t < 1000; t += 50) if (slow.accept(t)) all += 1;
  assert.equal(all, 20, 'a 20 Hz sensor is not thinned');
  // frames
  assert.equal(shouldApplyFrame(0.005, 1000), false, 'no change: no redraw');
  assert.equal(
    shouldApplyFrame(2, 16),
    false,
    'moving: not faster than 30 fps',
  );
  assert.equal(shouldApplyFrame(2, 33), true);
  assert.equal(
    shouldApplyFrame(0.05, 100),
    false,
    'still: not faster than 5 fps',
  );
  assert.equal(shouldApplyFrame(0.05, 200), true);
});

test('iOS compass: yaw correction from webkitCompassHeading recovers the magnetic frame in portrait; refused when ambiguous', () => {
  // the phone's real (magnetic) pose: portrait, back towards bearing 120, tilted up 15 deg
  const real = quatFromEuler(360 - 120, 105, 0);
  close(viewFromQuaternion(real).azDeg, 120, 1e-9);
  close(viewFromQuaternion(real).elDeg, 15, 1e-9);
  // slightly below the horizon (beta 60): back and top agree
  close(
    compassYawCorrection(addHeading(quatFromEuler(240, 60, 0), -20), 120),
    20,
    1e-9,
  );
  // looking well up (tilted back 40 deg past vertical): back and top point
  // opposite ways, so no reading is taken (the last correction is kept)
  assert.equal(compassYawCorrection(quatFromEuler(240, 130, 0), 120), null);
  // iOS reports alpha in an arbitrary yaw frame (here 57 deg off)
  const relative = addHeading(real, -57);
  const correction = compassYawCorrection(relative, 120);
  close(correction, 57, 1e-9);
  const fixed = addHeading(relative, correction);
  assert.ok(quatAngleDeg(fixed, real) < 1e-4); // acos precision near 1
  // flat on the palm, screen up, top to bearing 30: the top carries the heading
  const flat = quatFromEuler(360 - 30, 5, 0);
  close(compassYawCorrection(addHeading(flat, 10), 30), -10, 1e-9);
  // landscape: back and top point 90 deg apart -> which one iOS used is unknown
  const landscape = quatFromAxes(UP, N, W);
  assert.equal(compassYawCorrection(landscape, 90), null);
  // straight up: neither has a bearing
  assert.equal(compassYawCorrection(quatFromEuler(0, 180, 0), 10), null);
  assert.equal(compassYawCorrection(real, null), null);
});

test('states, messages, accuracy and align helpers', () => {
  assert.deepEqual(ORIENTATION_STATES, [
    'off',
    'asking',
    'on',
    'unsupported',
    'denied',
    'insecure',
    'calibrating',
  ]);
  for (const state of ORIENTATION_STATES.slice(1))
    assert.ok(orientationMessage(state).length > 10, state);
  assert.equal(orientationMessage('off'), '');
  assert.match(orientationMessage('insecure'), /secure https:\/\/ address/);
  assert.match(orientationMessage('denied'), /Drag still works/);
  assert.match(orientationMessage('unsupported'), /Drag/);
  assert.match(orientationMessage('calibrating'), /figure 8/);
  assert.match(orientationMessage('calibrating', 'relative'), /Align/);
  assert.equal(compassAccuracyPoor(-1), true);
  assert.equal(compassAccuracyPoor(30), true);
  assert.equal(compassAccuracyPoor(10), false);
  assert.equal(compassAccuracyPoor(undefined), false);
  assert.equal(alignDelta(5, 355), 10);
  assert.equal(alignDelta(350, 10), -20);
  // quaternion helpers stay unit length through compositions
  const q = quatMultiply(quatAxisAngle([0, 0, 1], 30), quatFromEuler(1, 2, 3));
  close(Math.hypot(...q), 1, 1e-12);
});
