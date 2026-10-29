import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { batchInstallationOutlines } from './navaraOutlineBatch.js';

function volume(id, x, { color = '#ff8800', opacity = 0.85, y = 0 } = {}) {
  const mesh = new Mesh(
    new BoxGeometry(10, 10, 40000),
    new MeshBasicMaterial({ color, opacity }),
  );
  mesh.matrix.makeTranslation(x, y, 0);
  mesh.userData.installationId = id;
  return mesh;
}

test('disjoint equal-colour outlines share a stencil volume without moving their vertices', () => {
  const meshes = [
    volume('a', 6_000_000),
    volume('b', 6_000_100),
    volume('c', 6_000_200),
  ];
  const positions = meshes.flatMap((m) => {
    const a = m.geometry.attributes.position;
    return Array.from({ length: a.count }, (_, i) =>
      new Vector3().fromBufferAttribute(a, i).applyMatrix4(m.matrix),
    );
  });
  const geometryDisposals = [],
    materialDisposals = [];
  for (const m of meshes) {
    m.geometry.addEventListener('dispose', () =>
      geometryDisposals.push(m.userData.installationId),
    );
    m.material.addEventListener('dispose', () =>
      materialDisposals.push(m.userData.installationId),
    );
  }
  const result = batchInstallationOutlines(meshes);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].userData.installationIds, ['a', 'b', 'c']);
  const a = result[0].geometry.attributes.position;
  assert.equal(a.count, positions.length);
  for (let i = 0; i < a.count; i++)
    assert.ok(
      new Vector3()
        .fromBufferAttribute(a, i)
        .applyMatrix4(result[0].matrix)
        .distanceTo(positions[i]) < 1e-5,
    );
  assert.deepEqual(geometryDisposals.sort(), ['a', 'b', 'c']);
  assert.deepEqual(materialDisposals.sort(), ['b', 'c']);
  result[0].geometry.dispose();
  result[0].material.dispose();
  assert.deepEqual(materialDisposals.sort(), ['a', 'b', 'c']);
});

test('overlapping volumes, different materials and distant origins retain separate draws and order', () => {
  for (const second of [
    volume('b', 5),
    volume('b', 100, { color: '#00ff00' }),
    volume('b', 100, { opacity: 0.5 }),
    volume('b', 100_001),
  ]) {
    const first = volume('a', 0),
      result = batchInstallationOutlines([first, second]);
    assert.deepEqual(result, [first, second]);
    for (const mesh of result) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
  const meshes = [
    volume('a', 0),
    volume('b', 100, { color: '#00ff00' }),
    volume('c', 200),
  ];
  assert.deepEqual(batchInstallationOutlines(meshes), meshes);
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});

test('batch admission compares against every prior volume, including rotated bounds', () => {
  const meshes = [volume('a', 0), volume('b', 100), volume('c', 0)];
  meshes[2].matrix.makeRotationZ(Math.PI / 4);
  const result = batchInstallationOutlines(meshes);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((m) => m.userData.installationIds),
    [['a', 'b'], ['c']],
  );
  for (const mesh of result) {
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
});
