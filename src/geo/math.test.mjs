// src/geo/math.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from './math.js';

const ANGLES = [
  0,
  1e-15,
  -1e-15,
  0.5,
  -0.5,
  Math.PI,
  -Math.PI,
  Math.PI + 1e-12,
  2 * Math.PI,
  -2 * Math.PI,
  2 * Math.PI - 1e-15,
  2 * Math.PI + 1e-15,
  3 * Math.PI,
  -3 * Math.PI,
  7.5,
  -7.5,
  100,
  -100,
  1e6,
  -1e6,
];

test('constants equal Cesium.Math', () => {
  for (const name of [
    'PI_OVER_TWO',
    'TWO_PI',
    'EPSILON10',
    'EPSILON12',
    'EPSILON14',
    'RADIANS_PER_DEGREE',
    'DEGREES_PER_RADIAN',
  ]) {
    assert.equal(geo[name], Cesium.Math[name], name);
  }
});

test('angle conversions equal Cesium bit for bit', () => {
  for (const value of [
    0, 1, -1, 45, 90, 180, 360, 123.456789, -73.9857, 1e-9,
  ]) {
    assert.equal(geo.toRadians(value), Cesium.Math.toRadians(value));
    assert.equal(geo.toDegrees(value), Cesium.Math.toDegrees(value));
  }
});

test('clamp, lerp and mod equal Cesium', () => {
  for (const [v, lo, hi] of [
    [5, 0, 1],
    [-5, 0, 1],
    [0.5, 0, 1],
    [0, 0, 0],
  ]) {
    assert.equal(geo.clamp(v, lo, hi), Cesium.Math.clamp(v, lo, hi));
  }
  for (const t of [0, 0.25, 1, 1.5, -0.5]) {
    assert.equal(geo.lerp(2, 10, t), Cesium.Math.lerp(2, 10, t));
  }
  for (const [m, n] of [
    [5, 3],
    [-5, 3],
    [5, -3],
    [-5, -3],
    [0, 3],
    [2, 3],
    [-2, 3],
  ]) {
    assert.equal(geo.mod(m, n), Cesium.Math.mod(m, n), `${m} mod ${n}`);
  }
});

test('angle normalisation equals Cesium at the edges', () => {
  for (const a of ANGLES) {
    assert.equal(
      geo.zeroToTwoPi(a),
      Cesium.Math.zeroToTwoPi(a),
      `zeroToTwoPi(${a})`,
    );
    assert.equal(
      geo.negativePiToPi(a),
      Cesium.Math.negativePiToPi(a),
      `negativePiToPi(${a})`,
    );
  }
});

test('the module does not import cesium', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./math.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]cesium['"]/);
});

test('equalsEpsilon equals Cesium, including the default epsilons', () => {
  const CASES = [
    [1, 1],
    [1, 1 + 1e-8, 1e-7],
    [1, 1 + 1e-6, 1e-7],
    [1e6, 1e6 + 0.05, 1e-7],
    [1e6, 1e6 + 0.5, 1e-7],
    [1e6, 1e6 + 0.5, 1e-7, 1],
    [0, 1e-15, 1e-14],
    [0, 1e-13, 1e-14],
    [-3, 3, 0.1, 6],
    [Number.NaN, Number.NaN, 1],
    [1, 2],
  ];
  for (const [l, r, rel, abs] of CASES) {
    assert.equal(
      geo.equalsEpsilon(l, r, rel, abs),
      Cesium.Math.equalsEpsilon(l, r, rel, abs),
      `${l} ~ ${r} (${rel}, ${abs})`,
    );
  }
});
