import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  conjugateQuaternion,
  fromAxes,
  fromAxisAngle,
  fromDegrees,
  fromHeadingPitchRoll,
  headingPitchRollFrame,
  headingPitchRollQuaternion,
  multiplyQuaternions,
  toAxes,
  toRadians,
} from './index.js';

function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const next = random(20261105);
const angle = () => (next() * 2 - 1) * 2 * Math.PI;
const axis = () => ({
  x: next() * 2 - 1,
  y: next() * 2 - 1,
  z: next() * 2 - 1,
});

/** Random rotations, plus ones near a half turn (trace ≤ 0, the other branch). */
function rotations(count = 400) {
  const out = [];
  for (let i = 0; i < count; i++) out.push([axis(), angle()]);
  for (const a of [
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 1e-3, z: -2e-3 },
  ])
    for (const t of [Math.PI, Math.PI - 1e-9, -Math.PI, 2.5, 0, 1e-12])
      out.push([a, t]);
  return out;
}

const same = (a, b, message) => {
  for (const k of ['x', 'y', 'z', 'w'])
    if (k in b) assert.equal(a[k], b[k], `${message} ${k}`);
};
const columns = (m) =>
  [0, 1, 2].map((c) => Cesium.Matrix3.getColumn(m, c, new Cesium.Cartesian3()));

test("axis-angle, product and axes are bit for bit the default renderer's", () => {
  let previous = Cesium.Quaternion.IDENTITY;
  let previousOurs = { x: 0, y: 0, z: 0, w: 1 };
  let otherBranch = 0;
  for (const [a, t] of rotations()) {
    const ours = fromAxisAngle(a, t);
    const theirs = Cesium.Quaternion.fromAxisAngle(
      new Cesium.Cartesian3(a.x, a.y, a.z),
      t,
    );
    same(ours, theirs, `fromAxisAngle(${JSON.stringify(a)}, ${t})`);

    same(
      multiplyQuaternions(ours, previousOurs),
      Cesium.Quaternion.multiply(theirs, previous, new Cesium.Quaternion()),
      'multiply',
    );
    previous = theirs;
    previousOurs = ours;

    const m = Cesium.Matrix3.fromQuaternion(theirs);
    const axes = toAxes(ours);
    const [c0, c1, c2] = columns(m);
    same(axes.x, c0, 'toAxes x');
    same(axes.y, c1, 'toAxes y');
    same(axes.z, c2, 'toAxes z');

    if (m[0] + m[4] + m[8] <= 0) otherBranch += 1;
    same(fromAxes(axes), Cesium.Quaternion.fromRotationMatrix(m), 'fromAxes');
  }
  assert.ok(otherBranch >= 20, `only ${otherBranch} rotations had trace ≤ 0`);
});

test('fromAxes inverts toAxes up to sign', () => {
  for (const [a, t] of rotations(100)) {
    const q = fromAxisAngle(a, t);
    const back = fromAxes(toAxes(q));
    const s = Math.sign(
      back.w * q.w + back.x * q.x + back.y * q.y + back.z * q.z,
    );
    for (const k of ['x', 'y', 'z', 'w'])
      assert.ok(
        Math.abs(back[k] * s - q[k]) < 1e-12,
        `${k}: ${back[k]} vs ${q[k]}`,
      );
  }
});

test('conjugateQuaternion undoes a rotation', () => {
  const q = fromAxisAngle({ x: 1, y: 2, z: 3 }, 0.7);
  const id = multiplyQuaternions(q, conjugateQuaternion(q));
  assert.ok(Math.abs(id.w - 1) < 1e-15 && Math.hypot(id.x, id.y, id.z) < 1e-15);
});

test("heading-pitch-roll matches the default renderer's", () => {
  for (let i = 0; i < 400; i++) {
    const hpr = { heading: angle(), pitch: angle() / 4, roll: angle() / 2 };
    same(
      fromHeadingPitchRoll(hpr),
      Cesium.Quaternion.fromHeadingPitchRoll(
        new Cesium.HeadingPitchRoll(hpr.heading, hpr.pitch, hpr.roll),
      ),
      `fromHeadingPitchRoll(${JSON.stringify(hpr)})`,
    );

    const lon = next() * 360 - 180;
    const lat = i < 4 ? [90, -90, 90, -90][i] : next() * 180 - 90;
    const height = next() * 2e7 - 1e3;
    const origin = fromDegrees(lon, lat, height);
    const cesiumHpr = new Cesium.HeadingPitchRoll(
      hpr.heading,
      hpr.pitch,
      hpr.roll,
    );
    const cesiumOrigin = Cesium.Cartesian3.fromDegrees(lon, lat, height);
    const frame = headingPitchRollFrame(origin, hpr);
    const m = Cesium.Transforms.headingPitchRollToFixedFrame(
      cesiumOrigin,
      cesiumHpr,
    );
    const cols = [0, 1, 2].map((c) =>
      Cesium.Matrix4.getColumn(m, c, new Cesium.Cartesian4()),
    );
    for (const [name, ours, theirs] of [
      ['x', frame.x, cols[0]],
      ['y', frame.y, cols[1]],
      ['z', frame.z, cols[2]],
    ])
      for (const k of ['x', 'y', 'z'])
        assert.ok(
          Math.abs(ours[k] - theirs[k]) <= 1e-12,
          `frame ${name}.${k} at ${lon},${lat}: ${ours[k]} vs ${theirs[k]}`,
        );

    const q = headingPitchRollQuaternion(origin, hpr);
    const qc = Cesium.Transforms.headingPitchRollQuaternion(
      cesiumOrigin,
      cesiumHpr,
    );
    // Either sign is the same rotation; near a zero trace the ENU frame's
    // last-bit differences can pick the other.
    const sign = q.x * qc.x + q.y * qc.y + q.z * qc.z + q.w * qc.w < 0 ? -1 : 1;
    for (const k of ['x', 'y', 'z', 'w'])
      assert.ok(
        Math.abs(q[k] * sign - qc[k]) <= 1e-12,
        `quaternion ${k}: ${q[k]} vs ${qc[k]}`,
      );
  }
});

test('heading-pitch-roll frames are exact on the polar axis, origin included', () => {
  const hprs = [
    { heading: 0, pitch: 0, roll: -Math.PI },
    { heading: 1.1, pitch: -0.4, roll: 0.3 },
    { heading: -2.5, pitch: 1.2, roll: 3 },
    {},
  ];
  for (const z of [6356752.3142451793, -6356752.3142451793, 1e7, -7e6])
    for (const hpr of hprs) {
      const origin = { x: 0, y: 0, z };
      const cesiumHpr = new Cesium.HeadingPitchRoll(
        hpr.heading ?? 0,
        hpr.pitch ?? 0,
        hpr.roll ?? 0,
      );
      const cesiumOrigin = new Cesium.Cartesian3(0, 0, z);
      const frame = headingPitchRollFrame(origin, hpr);
      const m = Cesium.Transforms.headingPitchRollToFixedFrame(
        cesiumOrigin,
        cesiumHpr,
      );
      ['x', 'y', 'z', 'origin'].forEach((name, c) =>
        ['x', 'y', 'z'].forEach((k, r) =>
          assert.ok(
            Object.is(frame[name][k], m[c * 4 + r]),
            `${name}.${k} at z=${z} ${JSON.stringify(hpr)}: ${frame[name][k]} vs ${m[c * 4 + r]}`,
          ),
        ),
      );
      same(
        headingPitchRollQuaternion(origin, hpr),
        Cesium.Transforms.headingPitchRollQuaternion(cesiumOrigin, cesiumHpr),
        `quaternion at z=${z}`,
      );
    }
});

test('the forward axis faces east at heading 0 and south at heading π/2', () => {
  const origin = fromDegrees(10, 45, 0);
  const at = (heading) => headingPitchRollFrame(origin, { heading }).x;
  const east = {
    x: -Math.sin(toRadians(10)),
    y: Math.cos(toRadians(10)),
    z: 0,
  };
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  assert.ok(Math.abs(dot(at(0), east) - 1) < 1e-12);
  assert.ok(Math.abs(dot(at(Math.PI / 2), east)) < 1e-12);
  assert.ok(at(Math.PI / 2).z < 0, 'heading π/2 turns towards the equator');
});

test('an axis with no direction throws', () => {
  assert.throws(() => fromAxisAngle({ x: 0, y: 0, z: 0 }, 1), RangeError);
});
