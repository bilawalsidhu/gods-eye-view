import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoverFrameCamera } from './frameCamera.js';

function setup() {
  let updates = 0;
  const raw = {
    position: { x: 6372000, y: 2, z: 3 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
    parent: null,
    matrixAutoUpdate: true,
    fov: 60,
    matrixWorld: { elements: new Float64Array(16) },
    updateMatrixWorld() {
      updates++;
      const e = this.matrixWorld.elements;
      e[12] = this.position.x;
      e[13] = this.position.y;
      e[14] = this.position.z;
      e[8] = 0;
      e[9] = this.quaternion.y;
      e[10] = 2;
    },
  };
  const renderer = {
    domElement: { clientHeight: 800 },
    getPixelRatio: () => 1,
  };
  const ctx = { getRenderer: () => renderer };
  const read = createMoverFrameCamera({ camera: { raw } });
  return { read, raw, renderer, ctx, updates: () => updates };
}

test('mover sets share one matrix update in a frame and refresh next frame', () => {
  const f = setup();
  const first = f.read(f.ctx, 100);
  for (let i = 0; i < 30; i++) assert.equal(f.read(f.ctx, 100), first);
  assert.equal(f.updates(), 1);
  assert.deepEqual(first.cameraDirection, { x: -0, y: -0, z: -1 });
  assert.equal(first.cameraPosition.x, 6372000);
  f.read(f.ctx, 101);
  assert.equal(f.updates(), 2);
});

test('same-frame camera moves, rotations, resize and DPR never reuse stale data', () => {
  const f = setup();
  f.read(f.ctx, 100);
  f.raw.position.x += 100;
  assert.equal(f.read(f.ctx, 100).cameraPosition.x, 6372100);
  f.raw.quaternion.y = 2;
  assert.ok(
    Math.abs(f.read(f.ctx, 100).cameraDirection.y + Math.SQRT1_2) < 1e-12,
  );
  f.renderer.domElement.clientHeight = 600;
  assert.equal(f.read(f.ctx, 100).viewportHeightPx, 600);
  f.renderer.getPixelRatio = () => 2;
  assert.equal(f.read(f.ctx, 100).pixelRatio, 2);
  assert.equal(f.updates(), 5);
});

test('missing frames and nonstandard camera transforms keep the uncached path', () => {
  for (const modify of [
    () => {},
    (f) => {
      f.raw.parent = {};
    },
    (f) => {
      f.raw.matrixAutoUpdate = false;
    },
    (f) => {
      f.raw.scale.x = 2;
    },
    (f) => {
      f.raw.matrixWorldAutoUpdate = false;
    },
  ]) {
    const f = setup();
    modify(f);
    const time =
      f.raw.parent ||
      !f.raw.matrixAutoUpdate ||
      f.raw.scale.x !== 1 ||
      f.raw.matrixWorldAutoUpdate === false
        ? 100
        : undefined;
    f.read(f.ctx, time);
    f.read(f.ctx, time);
    assert.equal(f.updates(), 2);
  }
});

test('a hidden canvas has no snapshot and independent views do not share scratch state', () => {
  const a = setup(),
    b = setup();
  a.renderer.domElement.clientHeight = 0;
  assert.equal(a.read(a.ctx, 100), null);
  a.renderer.domElement.clientHeight = 800;
  const first = a.read(a.ctx, 100);
  b.raw.position.x += 900;
  assert.notEqual(first, b.read(b.ctx, 100));
  assert.equal(first.cameraPosition.x, 6372000);
});
