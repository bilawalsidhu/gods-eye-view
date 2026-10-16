import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { createMoverStore, normalizeMoverSetOptions } from '../../movers.js';
import { createModelMover } from './modelMover.js';

const options = normalizeMoverSetOptions({
  id: 'm',
  kind: 'model',
  capacity: 2,
  model: {
    url: '/models/box.glb',
    minimumPixelSize: 40,
    colorBlend: { mode: 'mix', amount: 0.3 },
  },
});

function fakeGltf() {
  const scene = new Group();
  const box = new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial());
  box.position.set(0, 1, 0);
  scene.add(box);
  return { scene };
}

test('instances share the model meshes, placed from the origin', async () => {
  const store = createMoverStore(options);
  const mover = createModelMover(options, store, {
    load: async () => fakeGltf(),
  });
  store.set(0, { position: { x: 6_378_137, y: 0, z: 0 } });
  store.set(1, {
    position: { x: 6_378_147, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
    color: [1, 0, 0, 1],
  });
  store.setCount(2);
  mover.commit(store.dirty());
  await mover.group.ready;
  const [mesh] = mover.group.meshes;
  assert.equal(mesh.count, 2);
  assert.equal(mesh.position.x, 6_378_137);
  assert.equal(mover.uniforms.uGevBlend.value, 0.3);
  const matrix = new Matrix4();
  mesh.getMatrixAt(1, matrix);
  const translation = new Vector3().setFromMatrixPosition(matrix);
  // Offset 10 m east of the origin plus the box's local +1 y turned 90° about z.
  assert.ok(Math.abs(translation.x - 9) < 1e-9, translation.x);
  assert.ok(Math.abs(translation.y) < 1e-9);
  const color = mesh.geometry.getAttribute('gevColor');
  assert.deepEqual([...color.array.subarray(4, 8)], [1, 0, 0, 1]);
});

test('a far model keeps its minimum pixel size', async () => {
  const store = createMoverStore(options);
  const mover = createModelMover(options, store, {
    load: async () => fakeGltf(),
  });
  store.set(0, { position: { x: 6_378_137, y: 0, z: 0 } });
  store.setCount(1);
  mover.commit(store.dirty());
  await mover.group.ready;
  mover.update({
    cameraPosition: { x: 6_378_137 + 100_000, y: 0, z: 0 },
    cameraHeight: 100_000,
    fovDeg: 60,
    viewportHeightPx: 800,
  });
  const matrix = new Matrix4();
  mover.group.meshes[0].getMatrixAt(0, matrix);
  const scale = new Vector3().setFromMatrixScale(matrix).x;
  // Box radius √3; 40 px at 100 km with a 60° fov over 800 px.
  const footprint = (2 * Math.tan(Math.PI / 6)) / 800;
  const expected = (40 * footprint * 100_000) / (2 * Math.sqrt(3));
  assert.ok(
    Math.abs(scale - expected) / expected < 1e-6,
    `${scale} vs ${expected}`,
  );
});
