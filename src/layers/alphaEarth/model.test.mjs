import test from 'node:test';
import assert from 'node:assert/strict';

import {
  changeSummary,
  changedFraction,
  clampThreshold,
  colorizeChange,
  decodeGrid,
  defaultYears,
  dequantizeBox,
  normalizeYears,
  quantizeBox,
  validateAlphaEarthBox,
} from './model.js';

test('boxes are ordered, finite and at most 100 km a side', () => {
  const ok = validateAlphaEarthBox({ west: -97.64, south: 30.24, east: -97.6, north: 30.21 });
  assert.equal(ok.ok, true);
  assert.equal(ok.box.south, 30.21, 'latitudes are ordered');
  assert.equal(validateAlphaEarthBox({ west: 1, south: 0, east: 0, north: 1 }).reason, 'dateline');
  assert.equal(validateAlphaEarthBox({ west: 0, south: 0, east: 0, north: 1 }).reason, 'degenerate');
  assert.equal(validateAlphaEarthBox({ west: 0, south: 86, east: 1, north: 86.1 }).reason, 'polar');
  assert.equal(validateAlphaEarthBox({ west: 'x', south: 0, east: 1, north: 1 }).reason, 'invalid');
  const big = validateAlphaEarthBox({ west: 0, south: 0, east: 1, north: 1 });
  assert.equal(big.reason, 'too-large');
  assert.match(big.message, /111 km wide · limit 100 km/);
});

test('years are distinct, published and ordered', () => {
  assert.deepEqual(normalizeYears(2024, 2018), { from: 2018, to: 2024 });
  assert.equal(normalizeYears(2018, 2018), null);
  assert.equal(normalizeYears(2016, 2018), null);
  assert.equal(normalizeYears(2018, 2030, [2018, 2024]), null);
  assert.deepEqual(defaultYears([2017, 2018, 2025, 2024]), { from: 2018, to: 2025 });
  assert.deepEqual(defaultYears([2017, 2018]), { from: 2017, to: 2018 });
  assert.equal(defaultYears([2024]), null);
});

test('thresholds stay in (0, 1] at two decimals', () => {
  assert.equal(clampThreshold(0.333), 0.33);
  assert.equal(clampThreshold(0, 0.5), 0.5);
  assert.equal(clampThreshold(2, 0.5), 0.5);
  assert.equal(clampThreshold('abc'), 0.35);
});

test('the grid decodes only at its declared size', () => {
  const base64 = Buffer.from([0, 127, 254, 255]).toString('base64');
  assert.deepEqual([...decodeGrid(base64, 2, 2)], [0, 127, 254, 255]);
  assert.equal(decodeGrid(base64, 3, 2), null);
  assert.equal(decodeGrid(42, 2, 2), null);
});

test('changed share and colours follow the client threshold', () => {
  const grid = Uint8Array.from([0, 50, 200, 254, 255]);
  assert.equal(changedFraction(grid, 0.35), 0.5);
  assert.equal(changedFraction(grid, 0.9), 0.25);
  assert.equal(changedFraction(Uint8Array.from([255]), 0.3), null);
  const rgba = colorizeChange(grid, 0.35);
  assert.equal(rgba[3], 0, 'unchanged is transparent');
  assert.equal(rgba[7], 0);
  assert.ok(rgba[11] > 0, 'changed is visible');
  assert.ok(rgba[15] > rgba[11], 'more change is more opaque');
  assert.equal(rgba[19], 0, 'NoData is transparent');
});

test('box params round-trip at 1e-4 degrees', () => {
  const box = { west: -97.64001, south: 30.21, east: -97.6, north: 30.24 };
  const back = dequantizeBox(quantizeBox(box));
  assert.equal(back.west, -97.64);
  assert.equal(dequantizeBox({ west: null, south: 1, east: 2, north: 3 }), null);
});

test('a quiet grid names its strongest change and the threshold for its top 1%', () => {
  // 990 still pixels at 0.01, ten at 0.30 and one NoData.
  const grid = new Uint8Array(1001).fill(3);
  grid.fill(76, 990, 1000);
  grid[1000] = 255;
  assert.deepEqual(changeSummary(grid), { strongest: 0.3, revealThreshold: 0.29 });
  assert.equal(changedFraction(grid, 0.29), 0.01);
  assert.equal(changeSummary(new Uint8Array(4)).revealThreshold, 0.05, 'never below the slider');
  assert.equal(changeSummary(Uint8Array.from([255])), null);
});
