import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cellPixels,
  smoothGibsTile,
  tileCentreLatitude,
} from './gibsSmoothing.js';

const TILE = 256;

function tile(paint) {
  const rgba = new Uint8ClampedArray(TILE * TILE * 4);
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const colour = paint(x, y);
      if (colour) rgba.set(colour, (y * TILE + x) * 4);
    }
  return rgba;
}

const pixel = (rgba, x, y) => [
  ...rgba.subarray((y * TILE + x) * 4, (y * TILE + x) * 4 + 4),
];

test('a cell is about 11 pixels wide at level 6 and taller toward the poles', () => {
  assert.ok(Math.abs(cellPixels(6, 0, 0.25)[0] - 11.38) < 0.01);
  const [across, down] = cellPixels(6, 60, 0.25);
  assert.ok(Math.abs(down - across * 2) < 0.01);
  assert.ok(Math.abs(tileCentreLatitude(1, 0) - 66.51) < 0.01);
});

test('coarse levels, where a cell is under a pixel, are returned unchanged', () => {
  const centre = tile(() => [10, 20, 30, 255]);
  assert.equal(
    smoothGibsTile((dx, dy) => (dx || dy ? null : centre), 1, 0, 0.25),
    centre,
  );
});

test('a uniform sea stays exactly uniform, edges included', () => {
  const sea = tile(() => [200, 100, 50, 255]);
  const out = smoothGibsTile(() => sea, 6, 27, 0.25);
  for (const [x, y] of [
    [0, 0],
    [128, 128],
    [255, 255],
    [0, 255],
  ])
    assert.deepEqual(pixel(out, x, y), [200, 100, 50, 255]);
});

test('hard cell steps become a ramp, and the result is continuous across a tile seam', () => {
  // One global pattern of 11-pixel cells, cut into tiles starting at `origin`.
  const stripes = (origin) => (dx) =>
    tile((x) =>
      Math.floor((origin + dx * TILE + x) / 11) % 2
        ? [255, 0, 0, 255]
        : [0, 0, 255, 255],
    );
  const left = smoothGibsTile(stripes(0), 6, 27, 0.25);
  const right = smoothGibsTile(stripes(TILE), 6, 27, 0.25);
  const reds = Array.from({ length: 22 }, (_, x) => pixel(left, x, 100)[0]);
  assert.ok(new Set(reds).size > 6, 'intermediate shades between the cells');
  // A tile whose middle straddles that seam must agree with both sides of it.
  const middle = smoothGibsTile(stripes(TILE / 2), 6, 27, 0.25);
  assert.deepEqual(pixel(middle, 127, 100), pixel(left, 255, 100));
  assert.deepEqual(pixel(middle, 128, 100), pixel(right, 0, 100));
});

test('a stair-stepped coastline is redrawn as a smooth edge with partial alpha', () => {
  // Land (transparent) above a staircase with 11-pixel steps.
  const coast = tile((x, y) =>
    y >= 64 + Math.floor(x / 11) * 6 ? [0, 128, 255, 255] : null,
  );
  const out = smoothGibsTile(() => coast, 6, 27, 0.25);
  const alphas = new Set();
  for (let y = 60; y < 110; y++) alphas.add(pixel(out, 60, y)[3]);
  assert.ok(
    [...alphas].some((a) => a > 0 && a < 255),
    'anti-aliased edge',
  );
  // Sea colour is kept at full strength inside the edge, not darkened by land.
  assert.deepEqual(pixel(out, 60, 200), [0, 128, 255, 255]);
  const edge = [...Array(TILE).keys()].find((y) => pixel(out, 60, y)[3] > 0);
  assert.deepEqual(pixel(out, 60, edge).slice(0, 3), [0, 128, 255]);
});
