import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoverStore, normalizeMoverSetOptions } from '../../movers.js';
import {
  atlasUvRects,
  footprintPerDepth,
  originFor,
  packInstances,
} from './pack.js';

test('the footprint of a CSS pixel per metre of depth follows the vertical fov', () => {
  // 90° fov over 800 px: 2·tan(45°)/800.
  assert.ok(Math.abs(footprintPerDepth(90, 800) - 2 / 800) < 1e-12);
  assert.equal(footprintPerDepth(60, 0), 0);
});

test('atlas cells become three uv rects (v up from the image bottom)', () => {
  const rects = atlasUvRects({ a: [0, 0, 0.5, 0.25], b: [0.5, 0.5, 1, 1] }, [
    'a',
    'b',
  ]);
  assert.deepEqual([...rects], [0, 0.75, 0.5, 1, 0.5, 0, 1, 0.5]);
});

test('the origin follows the camera only past a distance that grows with height', () => {
  const origin = { x: 6_378_137, y: 0, z: 0 };
  const near = { x: 6_378_137 + 500, y: 0, z: 0 };
  assert.equal(originFor(near, origin, 150), origin, 'within 1 km at 150 m');
  const far = { x: 6_378_137 + 2_000, y: 0, z: 0 };
  assert.deepEqual(originFor(far, origin, 150), far);
  assert.equal(originFor(far, origin, 1e6), origin, 'within 100 km at 1000 km');
  assert.deepEqual(originFor(far, null, 1e6), far, 'no origin yet');
});

test('instances pack as offsets from the origin, style, colour and uv', () => {
  const options = normalizeMoverSetOptions({
    id: 's',
    kind: 'sprite',
    capacity: 3,
    sprite: {
      atlas: { canvas: {}, cells: { a: [0, 0, 1, 1], b: [0, 0, 0.5, 0.5] } },
      sizePx: 10,
    },
  });
  const store = createMoverStore(options);
  store.set(0, {
    position: { x: 1000.5, y: 2000, z: 3000 },
    rotation: 1,
    scale: 2,
  });
  store.set(1, {
    position: { x: 1001, y: 2001, z: 3001 },
    show: false,
    cell: 'b',
    color: [1, 0, 0, 0.5],
  });
  store.setCount(2);
  const out = {
    matrices: new Float32Array(48),
    style: new Float32Array(12),
    colors: new Float32Array(12),
    uvs: new Float32Array(12),
  };
  for (let index = 0; index < 3; index++) {
    out.matrices[index * 16] = 1;
    out.matrices[index * 16 + 5] = 1;
    out.matrices[index * 16 + 10] = 1;
    out.matrices[index * 16 + 15] = 1;
  }
  const uvRects = atlasUvRects(options.sprite.atlas.cells, options.cellKeys);
  packInstances(store, 0, 2, { x: 1000, y: 2000, z: 3000 }, uvRects, out);
  // Identity matrix with the offset as translation.
  assert.deepEqual(
    [...out.matrices.subarray(0, 16)],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0, 0, 1],
  );
  assert.deepEqual([...out.matrices.subarray(28, 31)], [1, 1, 1]);
  // rotation, scale (0 when hidden), and cached cosine/sine.
  assert.deepEqual([...out.style.subarray(0, 2)], [1, 2]);
  assert.ok(Math.abs(out.style[2] - Math.cos(1)) < 1e-7);
  assert.ok(Math.abs(out.style[3] - Math.sin(1)) < 1e-7);
  assert.deepEqual([...out.style.subarray(4, 8)], [0, 0, 1, 0]);
  assert.deepEqual([...out.colors.subarray(4, 8)], [1, 0, 0, 0.5]);
  assert.deepEqual([...out.uvs.subarray(0, 4)], [0, 0, 1, 1]);
  assert.deepEqual([...out.uvs.subarray(4, 8)], [0, 0.5, 0.5, 1]);
});
