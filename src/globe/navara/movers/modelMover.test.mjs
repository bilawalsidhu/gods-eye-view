import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  Texture,
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
  ); // CPU picks read the drawn radius: half the 40 px minimum (the pixel
  // size at the pre-minimum distance, so within a radius's worth).
  assert.ok(Math.abs(mover.pickRadiusPx(0) - 20) < 1e-3, mover.pickRadiusPx(0));
  assert.equal(mover.pickRadiusPx(1), null);
});

test("the instance colour mixes after lighting in sRGB, as Cesium's model colour", async () => {
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
      'void main() {\n#include <map_fragment>\n#include <emissivemap_fragment>\n#include <opaque_fragment>\n}',
  };
  mesh.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /diffuseColor\.a \*= vGevColor\.a;/);
  // Cesium ModelFS runs modelColorStage after lightingStage, in sRGB.
  assert.match(shader.fragmentShader, /vec3 gevLitSrgb = sRGBTransferOETF/);
  assert.match(
    shader.fragmentShader,
    /mix\(gevLitSrgb, vGevColor\.rgb, uGevBlend\)/,
  );
  assert.ok(
    shader.fragmentShader.indexOf('vec3 gevLitSrgb') >
      shader.fragmentShader.indexOf('#include <opaque_fragment>'),
  );
  assert.doesNotMatch(shader.fragmentShader, /diffuseColor\.rgb = mix/);
  // Ambient light belongs to the original surface before the colour mix.
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

test('disposing a model releases shared textures once, as well as each instanced mesh', async () => {
  const gltf = fakeGltf();
  const texture = new Texture();
  gltf.scene.children[0].material.map = texture;
  const second = gltf.scene.children[0].clone();
  gltf.scene.add(second);
  let released = 0;
  texture.addEventListener('dispose', () => released++);
  const mover = createModelMover(options, createMoverStore(options), {
    load: async () => gltf,
  });
  await mover.group.ready;
  let geometries = 0,
    materials = 0;
  for (const mesh of mover.group.meshes) {
    mesh.geometry.addEventListener('dispose', () => geometries++);
    mesh.material.addEventListener('dispose', () => materials++);
  }
  assert.equal(released, 0, 'textures remain live while the model draws');
  mover.dispose();
  mover.dispose();
  assert.equal(released, 1);
  assert.equal(geometries, 2);
  assert.equal(materials, 2);
});

test('a model removed before its load completes releases the arriving textures', async () => {
  let finish;
  const gltf = fakeGltf();
  const texture = new Texture();
  gltf.scene.children[0].material.map = texture;
  let released = 0,
    loaded = 0;
  texture.addEventListener('dispose', () => released++);
  const mover = createModelMover(options, createMoverStore(options), {
    load: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    onLoad: () => loaded++,
  });
  mover.dispose();
  finish(gltf);
  await mover.group.ready;
  assert.equal(released, 1);
  assert.equal(loaded, 0);
  assert.equal(mover.ready(), false);
  assert.equal(mover.group.meshes.length, 0);
});

test('a failed model load stays not-ready without an unhandled rejection or leaking the URL', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const store = createMoverStore(options);
  store.setCount(1);
  const mover = createModelMover(options, store, {
    load: async () => {
      throw new Error('unavailable asset URL');
    },
  });
  await new Promise(setImmediate);
  assert.equal(mover.ready(), false);
  assert.equal(mover.failed(), true);
  assert.equal(mover.group.meshes.length, 0);
  assert.deepEqual(warnings, ['[globe] Model asset unavailable']);
  mover.dispose();
});

test('an empty retained model bank leaves the render traversal and restores its cached instances', async () => {
  const store = createMoverStore(options);
  const mover = createModelMover(options, store, {
    load: async () => fakeGltf(),
  });
  await mover.group.ready;
  const [mesh] = mover.group.meshes;
  assert.equal(mesh.visible, false, 'loaded before its first instance');
  store.set(0, { position: { x: 6378137, y: 0, z: 0 } });
  store.setCount(1);
  mover.commit(store.dirty());
  store.clean();
  assert.equal(mesh.visible, true);
  const before = mesh.instanceMatrix.array.slice();
  store.setCount(0);
  mover.commit(store.dirty());
  store.clean();
  assert.equal(mesh.visible, false);
  assert.equal(mover.ready(), true, 'the asset remains cached');
  store.setCount(1);
  mover.commit(store.dirty());
  assert.equal(mesh.visible, true);
  assert.deepEqual(mesh.instanceMatrix.array, before);
  mover.dispose();
});

test('display tint shares transforms, preserves fade opacity and leaves no overlay resource after destruction', async () => {
  const children = new Set();
  const overlay = {
    uniforms: {
      tGevSceneDepth: { value: null },
      uGevResolution: { value: [1280, 800] },
    },
    add: (mesh) => children.add(mesh),
    remove: (mesh) => children.delete(mesh),
  };
  const store = createMoverStore(options);
  const mover = createModelMover(options, store, {
    load: async () => fakeGltf(),
    overlay,
  });
  store.set(0, {
    position: { x: 6378137, y: 0, z: 0 },
    color: [1, 0.2, 0.6, 0.4],
  });
  store.setCount(1);
  mover.commit(store.dirty());
  await mover.group.ready;
  const [base] = mover.group.meshes;
  const [tint] = children;
  assert.equal(tint.geometry, base.geometry);
  assert.equal(tint.instanceMatrix, base.instanceMatrix);
  assert.deepEqual(tint.position, base.position);
  assert.equal(tint.count, 1);
  assert.equal(tint.material.toneMapped, false);
  assert.equal(tint.material.depthWrite, false);
  const shader = {
    uniforms: {},
    vertexShader: 'void main() {\n#include <begin_vertex>\n}',
    fragmentShader:
      'void main() {\n#include <logdepthbuf_fragment>\n#include <opaque_fragment>\n}',
  };
  tint.material.onBeforeCompile(shader);
  assert.equal(shader.uniforms.tGevSceneDepth, overlay.uniforms.tGevSceneDepth);
  assert.match(shader.fragmentShader, /if \(gevOverlayHidden\(\)\) discard/);
  assert.match(
    shader.fragmentShader,
    /mix\(gevLitSrgb, vGevColor.rgb, uGevBlend\)/,
  );
  assert.match(shader.vertexShader, /vGevSonarFactor = gevSonarFactor/);
  assert.match(shader.fragmentShader, /gevSonarColor\(vec4\(mix/);
  assert.equal(base.material.colorWrite, false);
  assert.equal(
    mover.group.pickMeshes[0],
    tint,
    'GPU picking keeps its color-writing material',
  );
  store.set(0, { color: [1, 1, 1, 1] });
  mover.commit(store.dirty());
  assert.equal(
    tint.material.transparent,
    true,
    'sonar can fade an opaque model',
  );
  store.setCount(0);
  mover.commit(store.dirty());
  assert.equal(tint.count, 0);
  assert.equal(tint.visible, false);
  let disposed = 0;
  tint.material.addEventListener('dispose', () => disposed++);
  mover.dispose();
  mover.dispose();
  assert.equal(disposed, 1);
  assert.equal(children.size, 0);
});

test('the display pass preserves unlit model colour without a lighting tone curve', async () => {
  const children = new Set();
  const overlay = {
    uniforms: {},
    add: (mesh) => children.add(mesh),
    remove: (mesh) => children.delete(mesh),
  };
  const spec = { ...options, model: { ...options.model, unlit: true } };
  const mover = createModelMover(spec, createMoverStore(spec), {
    load: async () => fakeGltf(),
    overlay,
  });
  await mover.group.ready;
  const [mesh] = children;
  assert.equal(mesh.material.isMeshBasicMaterial, true);
  const shader = {
    uniforms: {},
    vertexShader: 'void main() {\n#include <begin_vertex>\n}',
    fragmentShader: 'void main() {\n#include <opaque_fragment>\n}',
  };
  mesh.material.onBeforeCompile(shader);
  assert.doesNotMatch(
    shader.fragmentShader,
    /gevModelAces\(gl_FragColor.rgb\)/,
  );
  mover.dispose();
});

for (const failures of [1, 2, 3])
  test(`model retries ${failures} failures with one budget and releases its timer`, async (t) => {
    t.mock.method(console, 'warn', () => {});
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const store = createMoverStore(options);
    let loads = 0;
    let added = 0;
    const mover = createModelMover({ ...options, retryAfterMs: 20 }, store, {
      load: async () => {
        if (++loads <= failures) throw new Error('503');
        return fakeGltf();
      },
    });
    mover.group.onLoad = () => added++;
    t.after(() => mover.dispose());
    store.set(0, { position: { x: 6378137, y: 0, z: 0 }, pickId: 'a' });
    store.setCount(1);
    mover.commit(store.dirty());
    await new Promise(setImmediate);
    assert.equal(mover.failed(0), true);
    for (let attempt = 0; attempt < 2; attempt++) {
      t.mock.timers.tick(19);
      assert.equal(loads, attempt + 1);
      t.mock.timers.tick(1);
      await new Promise(setImmediate);
      if (mover.ready()) break;
    }
    assert.equal(loads, Math.min(failures + 1, 3));
    assert.equal(mover.ready(), failures < 3);
    assert.equal(mover.failed(), failures === 3);
    t.mock.timers.tick(10000);
    assert.equal(loads, Math.min(failures + 1, 3));
    store.set(0, { pickId: 'b' });
    assert.equal(
      mover.failed(),
      false,
      'the replacement has no failed attempt',
    );
    mover.commit(store.dirty());
    assert.equal(mover.failed(0), false);
    await new Promise(setImmediate);
    assert.equal(mover.ready(0), true);
    assert.equal(added, failures < 3 ? 2 : 1);
    assert.equal(
      mover.group.meshes.length,
      1,
      'replacement does not accumulate meshes',
    );
    mover.dispose();
    t.mock.timers.tick(10000);
    assert.equal(loads, Math.min(failures + 1, 3) + 1);
  });

test('a pending obsolete identity releases its asset without overwriting the replacement', async (t) => {
  const store = createMoverStore(options);
  const pending = [];
  const mover = createModelMover(options, store, {
    load: () => new Promise((resolve) => pending.push(resolve)),
  });
  t.after(() => mover.dispose());
  store.set(0, { pickId: 'a' });
  store.setCount(1);
  mover.commit(store.dirty());
  store.set(0, { pickId: 'b' });
  mover.commit(store.dirty());
  const stale = fakeGltf();
  let released = 0;
  stale.scene.children[0].geometry.addEventListener(
    'dispose',
    () => released++,
  );
  pending[0](stale);
  await new Promise(setImmediate);
  assert.equal(released, 1);
  assert.equal(mover.ready(), false);
  pending[1](fakeGltf());
  await mover.group.ready;
  assert.equal(mover.ready(), true);
});

test('destroying a failed model cancels its pending retry', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let loads = 0;
  const mover = createModelMover(options, createMoverStore(options), {
    load: async () => {
      loads++;
      throw new Error('503');
    },
  });
  await new Promise(setImmediate);
  mover.dispose();
  t.mock.timers.tick(10000);
  assert.equal(loads, 1);
});
