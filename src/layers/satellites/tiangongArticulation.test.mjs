import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ISS_RELAY_LONGITUDES_DEG } from './issArticulation.js';
import { TIANGONG_MODEL_URL } from './policy.js';
import {
  TIANGONG_ARMS,
  TIANGONG_HGA,
  TIANGONG_ONE_AXIS_WINGS,
  TIANGONG_RELAY_LONGITUDES_DEG,
  TIANGONG_TWO_AXIS_WINGS,
  tiangongOneAxisAngle,
  tiangongRelayDirections,
  tiangongTwoAxisAngles,
  tiangongWingTargets,
} from './tiangongArticulation.js';
import { TIANGONG_JOINTS, tiangongJoint } from './tiangongJoints.js';

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v) => v.map((c) => c / Math.hypot(...v));
/** `v` turned by `angle` about `axis` (Rodrigues), the turn the matrix makes. */
const rotate = (v, axis, angle) => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [0, 1, 2].map((i) => v[i] * c + k[i] * s + axis[i] * d);
};

const SUNS = [
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [1, 0, 0],
  [0.5, 0.5, 0.7],
  [-0.6, 0.2, -0.77],
  [0.3, -0.9, 0.3],
  [0.9, 0.1, -0.4],
].map(unit);

test("the joint table is the model build's: 37 nodes, every kind, frozen", () => {
  assert.equal(TIANGONG_JOINTS.length, 37);
  const kinds = new Map();
  for (const joint of TIANGONG_JOINTS) {
    kinds.set(joint.kind, (kinds.get(joint.kind) ?? 0) + 1);
    assert.ok(Object.isFrozen(joint) && Object.isFrozen(joint.pivot));
    assert.equal(joint.pivot.length, 3);
    assert.ok(Math.abs(Math.hypot(...joint.axis) - 1) < 1e-9, joint.node);
    if (joint.kind === 'dock') assert.equal(joint.rangeDeg, null);
    else assert.equal(joint.rangeDeg.length, 2);
  }
  // 2 Tianhe wings, 4 lab wings and 6 vehicle wings turn on alpha joints.
  assert.deepEqual(Object.fromEntries(kinds), {
    alpha: 12,
    beta: 4,
    antenna: 1,
    dock: 6,
    arm: 14,
  });
  assert.equal(tiangongJoint('CMM_EP').parent, 'CMM_SHP');
  assert.throws(() => tiangongJoint('NOT_A_JOINT'));
});

test('a one-axis wing turns its cell side onto the Sun, as far as its axis allows', () => {
  for (const wing of TIANGONG_ONE_AXIS_WINGS) {
    assert.ok(Math.abs(dot(wing.axis, wing.normal)) < 1e-9, wing.node);
    for (const sun of SUNS) {
      const angle = tiangongOneAxisAngle(sun, wing);
      const normal = rotate(wing.normal, wing.axis, angle);
      // The best the wing can do: the Sun's part across its axis.
      const reachable = Math.hypot(
        dot(sun, wing.normal),
        dot(sun, cross(wing.axis, wing.normal)),
      );
      if (reachable < 0.05) continue;
      assert.ok(
        Math.abs(dot(normal, sun) - reachable) < 1e-6,
        `${wing.node} ${sun}`,
      );
    }
  }
  // The Sun along the axis: nothing to steer by, the last angle holds.
  const tianhe = TIANGONG_ONE_AXIS_WINGS[0];
  assert.equal(tiangongOneAxisAngle([1, 0, 0], tianhe, 0.7), 0.7);
});

test('a lab wing faces the Sun exactly: alpha across it, beta onto it', () => {
  for (const pair of TIANGONG_TWO_AXIS_WINGS) {
    const joint = {
      alphaAxis: pair.alpha.axis,
      betaAxis: pair.beta.axis,
      normal: pair.normal,
    };
    for (const sun of SUNS) {
      if (Math.abs(dot(sun, pair.alpha.axis)) > 0.95) continue;
      const { alpha, beta } = tiangongTwoAxisAngles(sun, joint);
      // The beta joint hangs from the alpha joint: beta turns first.
      const normal = rotate(
        rotate(pair.normal, pair.beta.axis, beta),
        pair.alpha.axis,
        alpha,
      );
      assert.ok(dot(normal, sun) > 1 - 1e-6, `${pair.alpha.node} ${sun}`);
      const wingAxis = rotate(pair.beta.axis, pair.alpha.axis, alpha);
      assert.ok(
        Math.abs(dot(wingAxis, sun)) < 1e-6,
        'wing axis across the Sun',
      );
    }
    // Alpha keeps the half turn nearer its last answer.
    const first = tiangongTwoAxisAngles(unit([0.2, 1, 0.3]), joint, 0);
    const flipped = tiangongTwoAxisAngles(
      unit([0.2, 1, 0.3]),
      joint,
      first.alpha + Math.PI,
    );
    assert.ok(Math.abs(Math.abs(flipped.alpha - first.alpha) - Math.PI) < 1e-9);
    // Sun along the lab: alpha holds.
    assert.equal(tiangongTwoAxisAngles([1, 0, 0], joint, 0.4).alpha, 0.4);
  }
});

test("in the Earth's shadow every wing turns flat to the Earth, edge into the flight", () => {
  const targets = tiangongWingTargets(unit([0.3, -0.9, 0.3]), false, {
    one: TIANGONG_ONE_AXIS_WINGS.map(() => 3),
    alpha: TIANGONG_TWO_AXIS_WINGS.map(() => 3),
  });
  TIANGONG_ONE_AXIS_WINGS.forEach((wing, i) => {
    const normal = rotate(wing.normal, wing.axis, targets.one[i]);
    assert.ok(Math.abs(normal[1] - 1) < 1e-9, wing.node);
  });
  TIANGONG_TWO_AXIS_WINGS.forEach((pair, i) => {
    // The nearer half turn to 3 rad is ±π, with beta making up the rest.
    assert.ok(Math.abs(Math.cos(targets.alpha[i]) + 1) < 1e-9, pair.alpha.node);
    const normal = rotate(
      rotate(pair.normal, pair.beta.axis, targets.beta[i]),
      pair.alpha.axis,
      targets.alpha[i],
    );
    assert.ok(Math.abs(normal[1] - 1) < 1e-9);
  });
  // Lit, the targets face the Sun instead.
  const lit = tiangongWingTargets([0, 0, 1], true);
  assert.ok(Math.abs(Math.abs(lit.one[0]) - Math.PI / 2) < 1e-9);
});

test('the antenna aims at Tianlian, not TDRS: unit vectors, highest first', () => {
  assert.deepEqual([...TIANGONG_RELAY_LONGITUDES_DEG], [79.9, 171.04, 10.5]);
  assert.notDeepEqual(
    [...TIANGONG_RELAY_LONGITUDES_DEG],
    [...ISS_RELAY_LONGITUDES_DEG],
  );
  // Over 80°E at 400 km: Tianlian II-01 is nearly overhead.
  const lon = (79.9 * Math.PI) / 180;
  const r = 6_771_000;
  const position = [r * Math.cos(lon), r * Math.sin(lon), 0];
  const axes = {
    x: [-Math.sin(lon), Math.cos(lon), 0],
    y: [0, 0, 1],
    z: unit(position),
  };
  const directions = tiangongRelayDirections(position, axes);
  assert.equal(directions.length, 3);
  for (const d of directions) assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-9);
  assert.ok(directions[0][1] > 0.999, 'II-01 overhead');
  assert.ok(
    directions[0][1] >= directions[1][1] &&
      directions[1][1] >= directions[2][1],
  );
  assert.deepEqual(TIANGONG_HGA.axis, [0, 1, 0]);
});

test('the arms sway on one side of rest only, so they lift off the hull', () => {
  for (const joints of Object.values(TIANGONG_ARMS)) {
    assert.equal(joints.length, 7);
    for (const joint of joints) {
      if (!joint.sway) {
        assert.equal(joint.centre, 0);
        continue;
      }
      // The sway never crosses rest unless it is centred on it (wrist pitch).
      assert.ok(
        joint.centre === 0 || Math.abs(joint.centre) > joint.sway,
        joint.node,
      );
      assert.ok(joint.period > 0);
    }
  }
});

test('the model file has every joint node, under its parent, with an identity rest', () => {
  const glb = readFileSync(
    new URL(`../../../public${TIANGONG_MODEL_URL}`, import.meta.url),
  );
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
  const byName = new Map(gltf.nodes.map((node, index) => [node.name, index]));
  const parentOf = new Map();
  gltf.nodes.forEach((node, index) =>
    (node.children ?? []).forEach((child) => parentOf.set(child, index)),
  );
  for (const joint of TIANGONG_JOINTS) {
    const index = byName.get(joint.node);
    assert.ok(index !== undefined, joint.node);
    const node = gltf.nodes[index];
    assert.equal(
      gltf.nodes[parentOf.get(index)].name,
      joint.parent,
      joint.node,
    );
    if (joint.kind !== 'dock') {
      assert.equal(node.translation ?? null, null, joint.node);
      assert.equal(node.rotation ?? null, null, joint.node);
      assert.equal(node.matrix ?? null, null, joint.node);
    }
  }
  // Each wing's mesh is thin along the cell normal the rules assume.
  const thin = (meshNode, normal) => {
    const node = gltf.nodes[byName.get(meshNode)];
    const accessor =
      gltf.accessors[gltf.meshes[node.mesh].primitives[0].attributes.POSITION];
    const size = [0, 1, 2].map((i) => accessor.max[i] - accessor.min[i]);
    const along = normal.findIndex((c) => c !== 0);
    assert.ok(
      size[along] < Math.min(...size.filter((_, i) => i !== along)) / 3,
      meshNode,
    );
  };
  for (const wing of TIANGONG_ONE_AXIS_WINGS)
    thin(wing.node.replace(/_ALPHA$/, ''), wing.normal);
  for (const pair of TIANGONG_TWO_AXIS_WINGS)
    thin(pair.beta.node.replace(/_BETA$/, ''), pair.normal);
});
