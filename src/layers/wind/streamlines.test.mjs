import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bakeWindStreamlines,
  groupWindPaths,
  WIND_CELL_DEGREES,
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

test('regional grouping preserves every baked path and ordering within each cell', () => {
  const paths = bakeWindStreamlines(field());
  const before = structuredClone(paths);
  const groups = groupWindPaths(paths);
  assert.equal(WIND_CELL_DEGREES, 30);
  assert.equal(groups.length, 72);
  assert.deepEqual(paths, before, 'grouping leaves the bake untouched');
  const grouped = groups.flatMap((cell) => cell.paths);
  assert.equal(grouped.length, paths.length);
  assert.equal(new Set(grouped).size, paths.length);
  for (const cell of groups) {
    assert.deepEqual(
      cell.paths,
      paths.filter((path) => cell.paths.includes(path)),
    );
  }
  assert.deepEqual(groups, groupWindPaths(paths));
  assert.deepEqual(groupWindPaths([]), []);
});

test('grouping uses the middle coordinate, wraps longitude and clamps polar cell edges', () => {
  const path = (lon, lat) => ({
    coordinates: [
      [-15, -15],
      [lon, lat],
      [150, 80],
    ],
  });
  const a = path(-180, -90),
    b = path(180, -90),
    c = path(540, -90);
  const north = path(179.9, 90),
    boundary = path(-150, -60);
  const groups = groupWindPaths([a, north, boundary, b, c]);
  assert.deepEqual(groups, [
    { id: 0, paths: [a, b, c] },
    { id: 71, paths: [north] },
    { id: 13, paths: [boundary] },
  ]);
  assert.equal(groupWindPaths([a, north], 90).length, 2);
  for (const size of [0, -30, NaN, Infinity, 181])
    assert.throws(() => groupWindPaths([], size), RangeError);
});
