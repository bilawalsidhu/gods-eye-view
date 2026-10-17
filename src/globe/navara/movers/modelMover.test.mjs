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
import { createModelMover, modelPixelDistance } from './modelMover.js';

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
    cameraDirection: { x: -1, y: 0, z: 0 },
    cameraHeight: 100_000,
    fovDeg: 60,
    viewportHeightPx: 800,
  });
  const matrix = new Matrix4();
  mover.group.meshes[0].getMatrixAt(0, matrix);
  const scale = new Vector3().setFromMatrixScale(matrix).x;
  // Box radius √3; 40 px at 100 km (less the radius, as Cesium) with a 60°
  // fov over 800 px.
  const footprint = (2 * Math.tan(Math.PI / 6)) / 800;
  const expected =
    (40 * footprint * (100_000 - Math.sqrt(3))) / (2 * Math.sqrt(3));
  assert.ok(
    Math.abs(scale - expected) / expected < 1e-6,
    `${scale} vs ${expected}`,
  );
});

test("the instance colour tints by the set's blend amount; its alpha is opacity, as Cesium's model colour", async () => {
  const store = createMoverStore(options);
  const mover = createModelMover(options, store, {
    load: async () => fakeGltf(),
  });
  store.set(0, {
    position: { x: 6_378_137, y: 0, z: 0 },
    color: [1, 1, 1, 0.4],
  });
  store.setCount(1);
  mover.commit(store.dirty());
  await mover.group.ready;
  const [mesh] = mover.group.meshes;
  const shader = {
    uniforms: {},
    vertexShader: 'void main() {\n#include <begin_vertex>\n}',
    fragmentShader:
      'void main() {\n#include <map_fragment>\n#include <emissivemap_fragment>\n}',
  };
  mesh.material.onBeforeCompile(shader);
  assert.match(
    shader.fragmentShader,
    /diffuseColor\.rgb = mix\(diffuseColor\.rgb, vGevColor\.rgb, uGevBlend\);\s*diffuseColor\.a \*= vGevColor\.a;/,
  );
  // Ambient light on the tinted surface (Cesium's image-based lighting).
  assert.match(
    shader.fragmentShader,
    /totalEmissiveRadiance \+= diffuseColor\.rgb \* uGevAmbient;/,
  );
  assert.equal(mover.uniforms.uGevAmbient.value, 0.5);
  assert.equal(mesh.material.transparent, true, 'a faded instance');
  store.set(0, { color: [1, 1, 1, 1] });
  mover.commit(store.dirty());
  assert.equal(mesh.material.transparent, false, 'all opaque again');
});

test("the minimum pixel size is taken at Cesium's distance: view depth less the radius", () => {
  const ahead = { x: 0, y: 0, z: -1 };
  // 3 km ahead and 4 km aside: depth 3 km, not the 5 km straight line.
  assert.equal(modelPixelDistance(4000, 0, -3000, ahead, 30), 2970);
  assert.equal(modelPixelDistance(0, 0, -10, ahead, 30), 0);
  assert.equal(modelPixelDistance(4000, 0, -3000, null, 0), 5000);
});
