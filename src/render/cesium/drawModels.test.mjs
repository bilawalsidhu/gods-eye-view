import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceSpins,
  newSpins,
  partHighlightColor,
  respin,
  writePartTexture,
} from './drawModels.js';
import { partsModelGlb } from '../conformance/partsModel.js';
import { glbJson, gltfMeshMatrix, gltfPartTable } from '../modelParts.js';

/** Floats a part's row of the texture holds. */
const ROW = 32;

/** The part info `drawModels.js` reads from a model's GLB. */
function infoOf(glb) {
  const json = glbJson(glb);
  const mesh = gltfMeshMatrix(json);
  // The test models' node transforms are rotations, uniform scales and moves.
  const s = Math.hypot(mesh[0], mesh[1], mesh[2]);
  const r = (i, j) => mesh[j * 4 + i] / s;
  const t = [mesh[12], mesh[13], mesh[14]];
  const inv = new Array(16).fill(0);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) inv[j * 4 + i] = r(j, i) / s;
  for (let i = 0; i < 3; i++)
    inv[12 + i] = -(inv[i] * t[0] + inv[4 + i] * t[1] + inv[8 + i] * t[2]);
  inv[15] = 1;
  return { table: gltfPartTable(json), mesh, meshInverse: inv };
}

const row = (data, k, texel) =>
  Array.from(data.slice(k * ROW + texel * 4, k * ROW + texel * 4 + 4));

/** A part's matrix in the mesh frame, as rows of 4. */
const matrixOf = (data, k) => [0, 1, 2].map((t) => row(data, k, t));
/** Its normal matrix, as rows of 3, and whether it is moved. */
const normalsOf = (data, k) => ({
  rows: [3, 4, 5].map((t) => row(data, k, t).slice(0, 3)),
  moved: row(data, k, 3)[3],
});

const near = (a, b, eps = 1e-5) => a.every((v, i) => Math.abs(v - b[i]) < eps);

test('a part moved writes its matrix in the mesh’s own frame, the rest identity', () => {
  for (const node of [{}, { scale: 4, turnDeg: 90, translation: [3, 2, -1] }]) {
    const info = infoOf(partsModelGlb(node));
    const data = new Float32Array(4 * ROW);
    const posed = writePartTexture(
      info,
      { poses: { body: { offsetM: [15, 0, 0] } } },
      0,
      undefined,
      data,
    );
    assert.equal(posed, true);
    // The body's vertex at model (10, −10, −10) lands 15 m to its right
    // (−Z): back in the model frame through the node's transform.
    const m = info.mesh;
    const inv = info.meshInverse;
    const toMesh = (p) =>
      [0, 1, 2].map(
        (i) =>
          inv[i] * p[0] + inv[4 + i] * p[1] + inv[8 + i] * p[2] + inv[12 + i],
      );
    const toModel = (p) =>
      [0, 1, 2].map(
        (i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i],
      );
    const L = matrixOf(data, 0);
    const v = [...toMesh([10, -10, -10]), 1];
    const moved = toModel(L.map((r) => r.reduce((s, x, i) => s + x * v[i], 0)));
    assert.ok(near(moved, [10, -10, -25], 1e-4), JSON.stringify(moved));
    // A move turns no normal, but the part is marked moved.
    const n = normalsOf(data, 0);
    assert.equal(n.moved, 1);
    assert.ok(near(n.rows.flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1]));
  }
});

test('normals turn by the inverse transpose, exact under a stretch', () => {
  const info = infoOf(partsModelGlb());
  const data = new Float32Array(4 * ROW);
  writePartTexture(
    info,
    { poses: { pod: { yawDeg: 30 } } },
    0,
    [2, 1, 1],
    data,
  );
  const L = matrixOf(data, 1).map((r) => r.slice(0, 3));
  const { rows: N, moved } = normalsOf(data, 1);
  assert.equal(moved, 1);
  // N = L⁻ᵀ: Nᵀ · L is the identity.
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += N[k][i] * L[k][j];
      assert.ok(Math.abs(sum - (i === j ? 1 : 0)) < 1e-4, `${i},${j}: ${sum}`);
    }
  // A stretched turn is not a rotation: its own 3×3 would turn normals wrong.
  assert.ok(!near(N.flat(), L.flat(), 1e-3));
  // The body, at rest, is left as it is.
  assert.equal(normalsOf(data, 0).moved, 0);
});

test('a highlight that is not true or a colour draws none, and never throws', () => {
  const info = infoOf(partsModelGlb());
  const data = new Float32Array(4 * ROW);
  for (const highlight of ['', 'not a colour', 0, [1, 'x', 0], {}]) {
    writePartTexture(
      info,
      { poses: { pod: { highlight } } },
      0,
      undefined,
      data,
    );
    assert.deepEqual(row(data, 1, 6), [0, 0, 0, 0], String(highlight));
  }
  writePartTexture(
    info,
    { poses: { pod: { highlight: true } } },
    0,
    undefined,
    data,
  );
  assert.equal(row(data, 1, 6)[3], 1);
  writePartTexture(
    info,
    { poses: { pod: { highlight: [0, 1, 0] } } },
    0,
    undefined,
    data,
  );
  assert.deepEqual(row(data, 1, 6), [0, 1, 0, 1]);
  assert.equal(partHighlightColor('#00f').blue, 1);
  assert.equal(partHighlightColor('nope'), null);
  assert.equal(partHighlightColor(false), null);
});

test('a hidden part collapses, its normals left alone', () => {
  const info = infoOf(partsModelGlb());
  const data = new Float32Array(4 * ROW);
  writePartTexture(
    info,
    { poses: { pod: { hidden: true } } },
    0,
    undefined,
    data,
  );
  assert.ok(
    matrixOf(data, 1)
      .flat()
      .every((v) => v === 0),
  );
  assert.equal(normalsOf(data, 1).moved, 0);
  assert.ok(data.every(Number.isFinite));
});

test('spins keep their angle when their rate changes, and stop where they are', () => {
  const { table } = infoOf(partsModelGlb());
  const spins = newSpins(0);
  respin(spins, table, { spin: { pod: 90 } }, 0, () => 10);
  assert.equal(spins.angles.pod, 10);
  advanceSpins(spins, 1);
  assert.equal(spins.angles.pod, 100);
  // Twice as fast from here: no jump at the change.
  respin(spins, table, { spin: { pod: 180 } }, 1.5);
  assert.equal(spins.angles.pod, 145);
  advanceSpins(spins, 2);
  assert.equal(spins.angles.pod, 235);
  // Stopped: the angle stays; a name without an axis or a rate of 0 spins nothing.
  respin(spins, table, { spin: { body: 50, missing: 5, pod: 0 } }, 3);
  assert.equal(spins.angles.pod, (235 + 180) % 360);
  assert.equal(spins.rates.size, 0);
  advanceSpins(spins, 10);
  assert.equal(spins.angles.pod, (235 + 180) % 360);
});
