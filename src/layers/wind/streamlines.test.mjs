import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bakeWindStreamlines,
  groupWindPaths,
  WIND_CELL_DEGREES,
  WIND_PATH_LIMIT,
  WIND_PATH_STEPS,
} from './streamlines.js';
import { fieldStepCap } from './fieldSpec.js';

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

function regionalField({ u = 0.3, v = 0, gap = false } = {}) {
  // 10x10 lattice over lat 30..39, lon -75..-66 (about 1000 km), 1 deg cells.
  const n = 100;
  const U = new Float32Array(n).fill(u);
  const V = new Float32Array(n).fill(v);
  if (gap)
    for (let i = 0; i < 10; i++) U[4 * 10 + i] = V[4 * 10 + i] = -9999; // row lat 35
  return {
    nx: 10,
    ny: 10,
    lo1: -75,
    la1: 39,
    dx: 1,
    dy: 1,
    u: U,
    v: V,
    periodic: false,
    noData: -9999,
    bbox: { latMin: 30, latMax: 39, lonMin: -75, lonMax: -66 },
    speed: { medianMs: u, p95Ms: u },
  };
}

test('regional bake seeds inside the bbox, stops at its edge and never exceeds the step cap', () => {
  const options = { count: 200, stepSeconds: 1800 * 20, calmCutoffMs: 0.02 };
  const paths = bakeWindStreamlines(regionalField(), options);
  assert.ok(paths.length > 100);
  const cap = fieldStepCap(regionalField()); // 9/64 deg
  for (const path of paths) {
    for (const [lon, lat] of path.coordinates) {
      assert.ok(lon >= -75 - 1e-9 && lon <= -66 + 1e-9, `lon ${lon}`);
      assert.ok(lat >= 30 - 1e-9 && lat <= 39 + 1e-9, `lat ${lat}`);
    }
    for (let i = 1; i < path.coordinates.length; i++)
      assert.ok(
        Math.abs(path.coordinates[i][0] - path.coordinates[i - 1][0]) <=
          cap + 1e-9,
      );
  }
  assert.deepEqual(paths, bakeWindStreamlines(regionalField(), options));
});

test('a no-data row ends paths and an all-no-data field bakes no paths', () => {
  const gapped = regionalField({ gap: true, v: 0.3, u: 0 });
  const paths = bakeWindStreamlines(gapped, {
    count: 200,
    stepSeconds: 1800 * 20,
    calmCutoffMs: 0.02,
  });
  assert.ok(paths.length > 0);
  for (const path of paths)
    for (const [, lat] of path.coordinates)
      assert.ok(lat <= 34 + 1e-9 || lat >= 36 - 1e-9, `lat ${lat} inside the gap band`);
  const empty = regionalField();
  empty.u.fill(-9999);
  empty.v.fill(-9999);
  assert.deepEqual(bakeWindStreamlines(empty, { count: 50, calmCutoffMs: 0.02 }), []);
});

test('the calm cutoff comes from the caller and long steps are honoured (E1 check)', () => {
  assert.deepEqual(bakeWindStreamlines(regionalField({ u: 0.1 }), { count: 20 }), []); // below wind's 0.15
  const slow = bakeWindStreamlines(regionalField({ u: 0.1 }), {
    count: 20,
    calmCutoffMs: 0.02,
    stepSeconds: 18000,
    maxStepDegrees: 10,
  });
  const fast = bakeWindStreamlines(regionalField({ u: 1 }), {
    count: 20,
    calmCutoffMs: 0.02,
    stepSeconds: 1800,
    maxStepDegrees: 10,
  });
  assert.equal(slow.length, fast.length);
  assert.ok(slow.length > 0);
  const arc = (path) =>
    path.coordinates.reduce(
      (sum, p, i) =>
        i
          ? sum +
            Math.hypot(
              p[0] - path.coordinates[i - 1][0],
              p[1] - path.coordinates[i - 1][1],
            )
          : 0,
      0,
    );
  for (let i = 0; i < slow.length; i++) {
    assert.ok(Math.abs(arc(slow[i]) - arc(fast[i])) <= 1e-6 * arc(fast[i]));
    // Float32 field storage: 0.1 is stored as 0.10000000149.
    assert.ok(Math.abs(slow[i].speed - fast[i].speed / 10) < 1e-6);
  }
});

test('the wind bake is pinned to its pre-parameterization output (commit 02f6aa6b)', () => {
  // Numbers captured from the renderer before the field spec existed, for the
  // GPU test field (4x3, u = 15). A spec change that moves wind must fail here.
  const wind = {
    nx: 4, ny: 3, lo1: -180, la1: 90, dx: 90, dy: 90,
    u: new Float32Array(12).fill(15), v: new Float32Array(12),
  };
  const paths = bakeWindStreamlines(wind);
  assert.equal(paths.length, 7200);
  const pin = (index, seed, coordinates) => {
    assert.equal(paths[index].seed, seed);
    assert.equal(paths[index].speed, 15);
    assert.equal(paths[index].coordinates.length, 33);
    coordinates.forEach(([lon, lat], i) => {
      assert.ok(Math.abs(paths[index].coordinates[i][0] - lon) < 1e-12, `${index}[${i}] lon`);
      assert.ok(Math.abs(paths[index].coordinates[i][1] - lat) < 1e-12, `${index}[${i}] lat`);
    });
  };
  pin(0, 0, [[-12, -87.78380024676221], [-11.25, -87.78380024676221], [-10.5, -87.78380024676221]]);
  pin(1234, 1234, [[119.43515253228179, -41.04739170276931], [119.75675785818316, -41.04739170276931], [120.07836318408454, -41.04739170276931]]);
  pin(7199, 7199, [[-93.60660377750173, 87.78380024676221], [-92.85660377750173, 87.78380024676221], [-92.10660377750173, 87.78380024676221]]);
});
