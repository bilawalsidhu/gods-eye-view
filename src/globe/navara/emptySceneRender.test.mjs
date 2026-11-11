import test from 'node:test';
import assert from 'node:assert/strict';
import { Color, DirectionalLight, Group, Mesh, Scene } from 'three';
import { skipEmptySceneRenders } from './emptySceneRender.js';

function fixture() {
  const scenes = { mrt: new Scene(), opaque: new Scene() };
  scenes.mrt.add(new DirectionalLight());
  const calls = [];
  const renderer = {
    autoClear: false,
    shadowMap: { enabled: true, autoUpdate: false, needsUpdate: false },
    render(scene, camera) {
      calls.push({ scene, camera, receiver: this });
    },
  };
  const original = renderer.render;
  return { scenes, renderer, calls, original };
}

test('empty MRT/forward scenes skip resolves; real geometry and other scenes retain their ordered draws', () => {
  const f = fixture(),
    camera = {},
    other = new Scene(),
    receiver = {};
  const mesh = new Mesh();
  f.scenes.opaque.add(mesh);
  const run = skipEmptySceneRenders(function (renderer, arg) {
    assert.equal(this, receiver);
    assert.equal(arg, 42);
    renderer.render(f.scenes.mrt, camera);
    renderer.render(f.scenes.opaque, camera);
    renderer.render(other, camera);
    return 'result';
  }, f.scenes);
  assert.equal(run.call(receiver, f.renderer, 42), 'result');
  assert.deepEqual(
    f.calls.map((c) => c.scene),
    [f.scenes.opaque, other],
  );
  assert.ok(
    f.calls.every((c) => c.camera === camera && c.receiver === f.renderer),
  );
  assert.equal(f.renderer.render, f.original);
});

test('visibility changes are evaluated on each render without stale geometry caching', () => {
  const f = fixture(),
    group = new Group();
  group.add(new Mesh());
  group.visible = false;
  f.scenes.mrt.add(group);
  const run = skipEmptySceneRenders(
    (renderer) => renderer.render(f.scenes.mrt),
    f.scenes,
  );
  run(f.renderer);
  assert.equal(f.calls.length, 0);
  group.visible = true;
  run(f.renderer);
  assert.equal(f.calls.length, 1);
  group.removeFromParent();
  run(f.renderer);
  assert.equal(f.calls.length, 1);
});

test('clears, backgrounds, callbacks and pending shadow work keep the original render', () => {
  for (const configure of [
    (f) => {
      f.renderer.autoClear = true;
    },
    (f) => {
      f.scenes.mrt.background = new Color('red');
    },
    (f) => {
      f.scenes.mrt.onBeforeRender = () => {};
    },
    (f) => {
      f.scenes.mrt.onAfterRender = () => {};
    },
    (f) => {
      f.renderer.shadowMap.autoUpdate = true;
    },
    (f) => {
      f.renderer.shadowMap.needsUpdate = true;
    },
  ]) {
    const f = fixture();
    configure(f);
    skipEmptySceneRenders(
      (renderer) => renderer.render(f.scenes.mrt),
      f.scenes,
    )(f.renderer);
    assert.equal(f.calls.length, 1);
    assert.equal(f.renderer.render, f.original);
  }
});

test('nested passes and exceptions restore the exact borrowed renderer method', () => {
  const f = fixture();
  const inner = skipEmptySceneRenders(() => {
    throw new Error('render failure');
  }, f.scenes);
  const outer = skipEmptySceneRenders((renderer) => {
    const wrapped = renderer.render;
    assert.throws(() => inner(renderer), /render failure/);
    assert.equal(renderer.render, wrapped);
    throw new Error('outer failure');
  }, f.scenes);
  assert.throws(() => outer(f.renderer), /outer failure/);
  assert.equal(f.renderer.render, f.original);
  f.renderer.render(f.scenes.mrt);
  assert.equal(f.calls.length, 1);
});

test('manual clears must resolve on their own target before empty renders may be skipped', () => {
  const f = fixture(),
    first = {},
    second = {},
    targets = [];
  let target = first;
  const clear = () => targets.push(target);
  f.renderer.clear = clear;
  f.renderer.getRenderTarget = () => target;
  const run = skipEmptySceneRenders((renderer) => {
    renderer.clear(false, true, false);
    target = second;
    renderer.render(f.scenes.mrt);
    assert.equal(f.calls.length, 0);
    target = first;
    renderer.render(f.scenes.mrt);
    assert.equal(f.calls.length, 1, 'depth clear still needs its resolve');
    renderer.render(f.scenes.mrt);
    assert.equal(f.calls.length, 1, 'resolved empty target needs no repeat');
    renderer.clear(false, false, true);
    renderer.render(f.scenes.opaque);
    assert.equal(f.calls.length, 2, 'stencil clear also needs its resolve');
    throw new Error('after clear');
  }, f.scenes);
  assert.throws(() => run(f.renderer), /after clear/);
  assert.deepEqual(targets, [first, first]);
  assert.equal(f.renderer.clear, clear);
  assert.equal(f.renderer.render, f.original);
});
