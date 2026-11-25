import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  ISS_ALPHA_JOINTS,
  ISS_BETA_JOINTS,
  ISS_RADIATOR_JOINTS,
  issInShadow,
  issJointMatrix,
  issJointTargets,
  issStepAngle,
  issSunInModelFrame,
} from './issArticulation.js';

const rotX = (a, [x, y, z]) => [
  x,
  Math.cos(a) * y - Math.sin(a) * z,
  Math.sin(a) * y + Math.cos(a) * z,
];
const rotZ = (a, [x, y, z]) => [
  Math.cos(a) * x - Math.sin(a) * y,
  Math.sin(a) * x + Math.cos(a) * y,
  z,
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => v.map((c) => c / Math.hypot(...v));

const SUNS = [
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0.5, 0.5, 0.7],
  [-0.6, 0.2, -0.77],
  [0.3, -0.9, 0.3],
  [0.9, 0.1, -0.4],
].map(unit);

test('in sunlight every array faces the Sun, masts across it', () => {
  for (const sun of SUNS) {
    const { alpha, beta } = issJointTargets(sun, true);
    assert.ok(Math.abs(dot(rotX(alpha, [0, 0, 1]), sun)) < 1e-9);
    ISS_BETA_JOINTS.forEach(({ face }, i) => {
      // The beta joint hangs from the alpha joint: beta turns first.
      const normal = rotX(alpha, rotZ(beta[i], [face, 0, 0]));
      assert.ok(dot(normal, sun) > 1 - 1e-9, `${sun} array ${i}`);
    });
  }
});

test('the radiators stay edge-on to the Sun', () => {
  for (const sun of SUNS) {
    const { gamma } = issJointTargets(sun, true);
    assert.ok(Math.abs(dot(rotZ(gamma, [0, 1, 0]), sun)) < 1e-9);
  }
});

test('in the shadow the arrays feather along the flight direction', () => {
  const { alpha, beta } = issJointTargets(unit([0.2, -0.9, 0.3]), false, {
    alpha: 3,
    gamma: 0,
  });
  assert.ok(Math.abs(Math.sin(alpha)) < 1e-9); // masts back along ±Z
  assert.ok(Math.abs(alpha - Math.PI) < 1e-9); // the nearer half turn
  assert.deepEqual(
    beta,
    ISS_BETA_JOINTS.map(() => 0),
  );
});

test('a joint keeps the answer nearer its last one, and holds near its axis', () => {
  const first = issJointTargets(unit([0, 1, 0.01]), true);
  const next = issJointTargets(unit([0, 1, -0.01]), true, first);
  assert.ok(Math.abs(next.alpha - first.alpha) < 0.05);
  // Sun along the truss: nothing to steer the alpha joint by.
  const held = issJointTargets([1, 0, 0], true, { alpha: 1.2, gamma: 0.4 });
  assert.equal(held.alpha, 1.2);
});

test('angles step the short way round, capped', () => {
  assert.equal(issStepAngle(0, 1, 0.25), 0.25);
  assert.ok(issStepAngle(3, -3, 0.1) > 3); // through π, not back through 0
  assert.equal(issStepAngle(0.2, 0.3, 1), 0.3);
});

test('a joint matrix leaves its pivot in place', () => {
  for (const axis of ['x', 'z']) {
    const pivot = [3, -2, 5];
    const m = issJointMatrix(axis, pivot, 0.7, undefined);
    const moved = [0, 1, 2].map(
      (r) =>
        m[r] * pivot[0] + m[4 + r] * pivot[1] + m[8 + r] * pivot[2] + m[12 + r],
    );
    moved.forEach((v, i) => assert.ok(Math.abs(v - pivot[i]) < 1e-12));
  }
});

test('the shadow is the cylinder behind the Earth', () => {
  const sun = [1, 0, 0];
  assert.equal(issInShadow([6_790_000, 0, 0], sun), false);
  assert.equal(issInShadow([-6_790_000, 0, 0], sun), true);
  assert.equal(issInShadow([-1_000_000, 6_700_000, 0], sun), false);
});

test('the Sun lands on the model axes: port, zenith, forward', () => {
  const axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  assert.deepEqual(issSunInModelFrame([0.1, 0.2, 0.3], axes), [0.2, 0.3, 0.1]);
});

test('the model file has every joint node, beta joints under their alpha', () => {
  const buf = fs.readFileSync(
    new URL('../../../public/models/iss.glb', import.meta.url),
  );
  const json = JSON.parse(
    buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'),
  );
  const byName = new Map(json.nodes.map((n) => [n.name, n]));
  for (const { node } of [
    ...ISS_ALPHA_JOINTS,
    ...ISS_BETA_JOINTS,
    ...ISS_RADIATOR_JOINTS,
  ]) {
    const n = byName.get(node);
    assert.ok(n, node);
    // Joints rest at identity: the pivots above are in the model's own frame.
    assert.equal(n.rotation, undefined);
    assert.equal(n.translation, undefined);
    assert.equal(n.matrix, undefined);
  }
  for (const side of ['PORT', 'STBD']) {
    const kids = byName
      .get(`${side}_ALPHA_ROT`)
      .children.map((i) => json.nodes[i].name);
    for (const { node } of ISS_BETA_JOINTS)
      if (node.startsWith(side)) assert.ok(kids.includes(node), node);
  }
});

test('a dish aims its rest boresight (+Y) at the direction, pivot in place', async () => {
  const { issAimMatrix, ISS_DISH_JOINTS } =
    await import('./issArticulation.js');
  for (const direction of SUNS) {
    const m = issAimMatrix(ISS_DISH_JOINTS[0].pivot, direction, undefined);
    // Column 1 is where +Y goes.
    [m[4], m[5], m[6]].forEach((v, i) =>
      assert.ok(Math.abs(v - direction[i]) < 1e-9),
    );
    const p = ISS_DISH_JOINTS[0].pivot;
    [0, 1, 2].forEach((r) =>
      assert.ok(
        Math.abs(
          m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] - p[r],
        ) < 1e-9,
      ),
    );
  }
});

test('relay directions are unit vectors, highest above the station first', async () => {
  const { issRelayDirections } = await import('./issArticulation.js');
  // Over the equator at 41°W, flying east: the Atlantic relay is overhead.
  const lon = (-41 * Math.PI) / 180;
  const r = 6_790_000;
  const position = [r * Math.cos(lon), r * Math.sin(lon), 0];
  const zenith = [Math.cos(lon), Math.sin(lon), 0];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const axes = { x: east, y: [0, 0, 1], z: zenith };
  const relays = issRelayDirections(position, axes);
  assert.equal(relays.length, 3);
  relays.forEach((d) => assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-9));
  assert.ok(relays[0][1] > 0.999);
  assert.ok(relays[0][1] >= relays[1][1] && relays[1][1] >= relays[2][1]);
});

test('a direction steps along the arc, capped, and lands on the target', async () => {
  const { issStepDirection } = await import('./issArticulation.js');
  const stepped = issStepDirection([0, 1, 0], [1, 0, 0], 0.1);
  assert.ok(Math.abs(Math.hypot(...stepped) - 1) < 1e-9);
  assert.ok(Math.abs(Math.acos(stepped[1]) - 0.1) < 1e-9);
  assert.deepEqual(issStepDirection([0, 1, 0], [1, 0, 0], 2), [1, 0, 0]);
});

test('the model file has both dish nodes', async () => {
  const { ISS_DISH_JOINTS } = await import('./issArticulation.js');
  const buf = fs.readFileSync(
    new URL('../../../public/models/iss.glb', import.meta.url),
  );
  const json = JSON.parse(
    buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'),
  );
  for (const { node } of ISS_DISH_JOINTS) {
    const n = json.nodes.find((candidate) => candidate.name === node);
    assert.ok(n?.children?.length, node);
  }
});

test('the arm sways gently about the filed pose, and only where it is set to', async () => {
  const { ISS_ARM_JOINTS, issArmAngles } = await import('./issArticulation.js');
  assert.equal(ISS_ARM_JOINTS.length, 7);
  for (let seconds = 0; seconds < 400; seconds += 7) {
    issArmAngles(seconds).forEach((angle, i) => {
      assert.ok(Math.abs(angle) <= ISS_ARM_JOINTS[i].sway + 1e-12);
      // Illustrative, so kept small.
      assert.ok(Math.abs(angle) <= (12 * Math.PI) / 180 + 1e-12);
    });
  }
  assert.deepEqual(issArmAngles(0), [0, 0, 0, 0, 0, 0, 0]);
});

test('the smaller arms sway too, and their joints are in the model file', async () => {
  const { ISS_SMALL_ARM_JOINTS, ISS_ARM_JOINTS, issArmAngles } =
    await import('./issArticulation.js');
  const buf = fs.readFileSync(
    new URL('../../../public/models/iss.glb', import.meta.url),
  );
  const json = JSON.parse(
    buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'),
  );
  const names = new Set(json.nodes.map((n) => n.name));
  for (const { node, sway, axis } of [
    ...ISS_ARM_JOINTS,
    ...ISS_SMALL_ARM_JOINTS,
  ]) {
    assert.ok(names.has(node), node);
    assert.ok(sway <= (12 * Math.PI) / 180 + 1e-12);
    assert.ok(Math.abs(Math.hypot(...axis) - 1) < 1e-3);
  }
  assert.equal(
    issArmAngles(10, ISS_SMALL_ARM_JOINTS).length,
    ISS_SMALL_ARM_JOINTS.length,
  );
});
