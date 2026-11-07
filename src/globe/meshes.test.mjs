import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeshRegistry, meshRayDistance } from './meshes.js';

const triangles = {
  id: 'mesh',
  positions: [0, 0, 0, 2, 0, 0, 0, 2, 0],
  indices: [0, 1, 2],
};

test('mesh updates validate before drawing and copy caller geometry', () => {
  let state;
  let updates = 0;
  const registry = createMeshRegistry((initial) => {
    state = initial;
    return {
      update() {
        updates++;
      },
      destroy() {},
    };
  });
  const positions = [...triangles.positions];
  const handle = registry.meshes.createMesh({ ...triangles, positions });
  positions.fill(99);
  assert.deepEqual([...state.positions], triangles.positions);
  const previous = state.positions;
  handle.update({ color: [1, 0, 0, 0.5] });
  assert.equal(
    state.positions,
    previous,
    'colour does not copy or rebuild geometry',
  );
  for (const patch of [
    { positions: [0, 0, 0] },
    { positions: [NaN, ...triangles.positions.slice(1)] },
    { indices: [0, 1, 3] },
    { indices: [0, 1, 1.5] },
    { indices: [0, 1] },
    { uv: [0, 1] },
    { color: [1, 0, 0, 2] },
    { depthTest: 'bad' },
    { show: 0 },
    { image: {} },
  ])
    assert.throws(() => handle.update(patch), TypeError);
  assert.equal(updates, 1);
  assert.throws(() => registry.meshes.createMesh(triangles), /unique/);
  handle.destroy();
  handle.update({ show: true });
  assert.equal(handle.show(), false);
  registry.meshes.createMesh(triangles);
  registry.destroy();
  registry.destroy();
  assert.deepEqual(registry.meshes.list(), []);
  assert.throws(() => registry.meshes.createMesh(triangles), /destroyed/);
});

test('triangle ray intersection respects both faces, the triangle bounds and forward distance', () => {
  const ray = {
    origin: { x: 0.5, y: 0.5, z: 3 },
    direction: { x: 0, y: 0, z: -2 },
  };
  assert.equal(meshRayDistance(triangles, ray), 3);
  assert.equal(
    meshRayDistance(triangles, {
      ...ray,
      origin: { x: 0.5, y: 0.5, z: -3 },
      direction: { x: 0, y: 0, z: 1 },
    }),
    3,
  );
  assert.equal(
    meshRayDistance(triangles, { ...ray, origin: { x: 1.5, y: 1.5, z: 3 } }),
    Infinity,
  );
  assert.equal(
    meshRayDistance(triangles, { ...ray, direction: { x: 0, y: 0, z: 1 } }),
    Infinity,
  );
});
