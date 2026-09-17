import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bakeWindStreamlines,
  WIND_PATH_LIMIT,
  WIND_PATH_STEPS,
} from './streamlines.js';

function field(u = 12, v = 0) {
  return {
    nx: 4,
    ny: 3,
    lo1: -180,
    la1: 90,
    dx: 90,
    dy: 90,
    u: new Float32Array(12).fill(u),
    v: new Float32Array(12).fill(v),
  };
}

test('streamline bake is deterministic, equal-area and strictly bounded', () => {
  const first = bakeWindStreamlines(field(), { count: 24 });
  assert.deepEqual(first, bakeWindStreamlines(field(), { count: 24 }));
  assert.equal(first.length, 24);
  for (const path of first) {
    assert.ok(path.coordinates.length <= WIND_PATH_STEPS * 2 + 1);
    assert.ok(path.coordinates.length >= 3);
    for (let i = 1; i < path.coordinates.length; i++) {
      assert.ok(
        path.coordinates[i][0] > path.coordinates[i - 1][0],
        'eastward field has consistently eastward paths',
      );
      assert.ok(
        Math.abs(path.coordinates[i][0] - path.coordinates[i - 1][0]) < 1,
      );
      assert.ok(
        Math.abs(path.coordinates[i][1] - path.coordinates[i - 1][1]) < 1e-9,
      );
    }
  }
  const oversized = bakeWindStreamlines(field(), {
    count: 10000,
    steps: 10000,
  });
  assert.ok(oversized.length <= WIND_PATH_LIMIT);
  assert.ok(oversized.every((path) => path.coordinates.length <= 33));
});

test('bake stops at poles, seams, missing and calm data without invalid geometry', () => {
  assert.deepEqual(bakeWindStreamlines(field(0, 0)), []);
  assert.deepEqual(bakeWindStreamlines(field(NaN, 1)), []);
  assert.deepEqual(bakeWindStreamlines(null), []);
  for (const path of bakeWindStreamlines(field(150, 80), { count: 90 })) {
    for (let i = 0; i < path.coordinates.length; i++) {
      const [lon, lat] = path.coordinates[i];
      assert.ok(Number.isFinite(lon + lat));
      assert.ok(Math.abs(lat) <= 88.5);
      assert.ok(lon >= -180 && lon < 180);
      if (i) assert.ok(Math.abs(lon - path.coordinates[i - 1][0]) < 180);
    }
  }
});

test('midpoint integration bends paths with a changing northward component', () => {
  const snapshot = field(20, 0);
  snapshot.v = new Float32Array([
    -20, -10, 0, 10, -20, -10, 0, 10, -20, -10, 0, 10,
  ]);
  const path = bakeWindStreamlines(snapshot, { count: 1 })[0];
  assert.equal(path.coordinates.length, 33);
  const middle = path.coordinates[16];
  assert.equal(middle[0], 0);
  assert.ok(path.coordinates[0][1] > middle[1]);
  assert.ok(path.coordinates.at(-1)[1] > middle[1]);
});
