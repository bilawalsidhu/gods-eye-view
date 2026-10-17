import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUND_CAST_LIFT_M,
  MESH_LIFT_M,
  refineHeights,
  SURFACE_TERRAIN_ENTER_M,
  SURFACE_TERRAIN_EXIT_M,
  createGroundCaster,
  densifyLine,
  nextSurfaceMode,
} from './groundCast.js';

/** A terrain service whose ground rises 1 m per 0.001° east and 2 m per 0.001° north. */
function fakeTerrain({ source = 'reearth', fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async resolveEllipsoidalGround(coords) {
      calls.push(coords);
      if (fail) throw new Error('proxy down');
      return coords.map(({ lon, lat }) => ({
        ellipsoid: 100 + (lon - 10) * 1000 + (lat - 50) * 2000,
        source,
      }));
    },
  };
}

test('surface mode: terrain only on Google 3D at street zoom, with hysteresis', () => {
  const view = { photoreal: true, available: true };
  assert.equal(nextSurfaceMode('draped', { ...view, heightM: 500 }), 'terrain');
  assert.equal(
    nextSurfaceMode('draped', {
      ...view,
      heightM: (SURFACE_TERRAIN_ENTER_M + SURFACE_TERRAIN_EXIT_M) / 2,
    }),
    'draped',
  );
  assert.equal(
    nextSurfaceMode('terrain', {
      ...view,
      heightM: (SURFACE_TERRAIN_ENTER_M + SURFACE_TERRAIN_EXIT_M) / 2,
    }),
    'terrain',
  );
  assert.equal(
    nextSurfaceMode('terrain', {
      ...view,
      heightM: SURFACE_TERRAIN_EXIT_M + 1,
    }),
    'draped',
  );
  assert.equal(
    nextSurfaceMode('terrain', { ...view, photoreal: false, heightM: 200 }),
    'draped',
  );
  assert.equal(
    nextSurfaceMode('terrain', { ...view, available: false, heightM: 200 }),
    'draped',
  );
  assert.equal(
    nextSurfaceMode('terrain', { ...view, heightM: null }),
    'draped',
  );
});

test('densifyLine splits long segments and keeps the vertices', () => {
  const line = [
    [10, 50],
    [10.002, 50],
  ];
  const dense = densifyLine(line, 0.0005);
  assert.equal(dense.length, 5);
  assert.deepEqual(dense[0], [10, 50]);
  assert.deepEqual(dense.at(-1), [10.002, 50]);
  assert.ok(Math.abs(dense[2][0] - 10.001) < 1e-9);
  const short = [
    [10, 50],
    [10.0001, 50],
  ];
  assert.deepEqual(densifyLine(short, 0.0005), short);
  assert.deepEqual(densifyLine([[10, 50]]), [[10, 50]]);
});

test('densifyLine crosses the date line the short way and wraps what it adds', () => {
  // 0.0002° apart: short enough to stay one segment, not 65 points via 0°.
  const short = [
    [179.9999, 0],
    [-179.9999, 0],
  ];
  assert.deepEqual(densifyLine(short), short);
  const line = [
    [179.999, 50.0005],
    [-179.999, 50.0005],
  ];
  const dense = densifyLine(line, 0.0005);
  assert.equal(dense.length, 5);
  assert.deepEqual(dense[0], line[0]);
  assert.deepEqual(dense.at(-1), line[1]);
  for (const [lon] of dense)
    assert.ok(lon >= -180 && lon <= 180 && Math.abs(lon) >= 179.999, `${lon}`);
  assert.ok(Math.abs(dense[1][0] - 179.9995) < 1e-9);
  assert.ok(Math.abs(Math.abs(dense[2][0]) - 180) < 1e-9);
  assert.ok(Math.abs(dense[3][0] - -179.9995) < 1e-9);
  // Westward across the date line too.
  const back = densifyLine([...line].reverse(), 0.0005);
  assert.equal(back.length, 5);
  assert.ok(Math.abs(back[1][0] - -179.9995) < 1e-9);
});

test('the caster interpolates cached grid corners and adds the lift', async () => {
  const terrain = fakeTerrain();
  const caster = createGroundCaster({ terrain, step: 0.001 });
  assert.equal(caster.groundAt(10.0005, 50.0005), null);
  assert.equal(await caster.prepare([[10.0005, 50.0005]]), true);
  assert.equal(terrain.calls.length, 1);
  assert.equal(terrain.calls[0].length, 4);
  // Centre of the cell: mean of 100, 101, 102, 103.
  assert.ok(Math.abs(caster.groundAt(10.0005, 50.0005) - 101.5) < 1e-6);
  // A cast line sits the lift above it.
  const point = [10.0005, 50.0005];
  const [, , height] = caster.castLine([point, point]);
  assert.ok(Math.abs(height - (101.5 + GROUND_CAST_LIFT_M)) < 1e-6);
  // Same cell again: nothing to fetch.
  assert.equal(await caster.prepare([[10.0002, 50.0008]]), true);
  assert.equal(terrain.calls.length, 1);
});

test('castLine returns lon, lat, height triples or null when a corner is missing', async () => {
  const caster = createGroundCaster({ terrain: fakeTerrain(), step: 0.001 });
  const line = [
    [10.0001, 50.0001],
    [10.0009, 50.0001],
  ];
  assert.equal(caster.castLine(line), null);
  await caster.prepareLines([line]);
  const flat = caster.castLine(line);
  assert.equal(flat.length % 3, 0);
  assert.ok(flat.length >= 6);
  assert.equal(flat[0], 10.0001);
  assert.equal(flat[1], 50.0001);
  assert.ok(flat[2] > 100 && flat[2] < 110);
});

test('a geoid fallback or a failing proxy leaves the heights unknown', async () => {
  const fallback = createGroundCaster({
    terrain: fakeTerrain({ source: 'geoid-fallback' }),
  });
  assert.equal(await fallback.prepare([[10.0005, 50.0005]]), false);
  assert.equal(fallback.groundAt(10.0005, 50.0005), null);

  const down = createGroundCaster({ terrain: fakeTerrain({ fail: true }) });
  assert.equal(await down.prepare([[10.0005, 50.0005]]), false);
  assert.equal(down.groundAt(10.0005, 50.0005), null);
});

test('too many corners are not requested, and aborted prepares do nothing', async () => {
  const terrain = fakeTerrain();
  const caster = createGroundCaster({ terrain, step: 0.001, maxCorners: 8 });
  const wide = [];
  for (let i = 0; i < 10; i++) wide.push([10 + i * 0.001 + 0.0005, 50.0005]);
  assert.equal(await caster.prepare(wide), false);
  assert.equal(terrain.calls.length, 0);

  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await caster.prepare([[10.0005, 50.0005]], { signal: controller.signal }),
    false,
  );
  assert.equal(terrain.calls.length, 0);
});

test('prepares run one at a time so neighbours share corners', async () => {
  const terrain = fakeTerrain();
  const caster = createGroundCaster({ terrain, step: 0.001 });
  const [a, b] = await Promise.all([
    caster.prepare([[10.0005, 50.0005]]),
    caster.prepare([[10.0015, 50.0005]]),
  ]);
  assert.equal(a, true);
  assert.equal(b, true);
  // The second cell shares its west corners with the first.
  assert.equal(terrain.calls[1].length, 2);
});

test('the caster needs a terrain service', () => {
  assert.throws(() => createGroundCaster({ terrain: null }), TypeError);
});

test('refineHeights follows the mesh where it is the road', () => {
  // A freeway trench 6 m below the bare-earth grid, and a steep street 2 m above it.
  const heights = refineHeights([
    { dem: 100, mesh: 94 },
    { dem: 100, mesh: 102 },
    { dem: 100, mesh: null },
  ]);
  assert.deepEqual(heights, [
    94 + MESH_LIFT_M,
    102 + MESH_LIFT_M,
    100 + GROUND_CAST_LIFT_M,
  ]);
});

test('refineHeights carries the road under a canopy from both sides', () => {
  // Road 1 m and 3 m above bare earth either side of a tree 12 m tall.
  const heights = refineHeights([
    { dem: 50, mesh: 51 },
    { dem: 50, mesh: 62 },
    { dem: 50, mesh: 62 },
    { dem: 50, mesh: 53 },
  ]);
  assert.equal(heights[0], 51 + MESH_LIFT_M);
  assert.ok(Math.abs(heights[1] - (50 + 1 + 2 / 3 + MESH_LIFT_M)) < 1e-9);
  assert.ok(Math.abs(heights[2] - (50 + 1 + 4 / 3 + MESH_LIFT_M)) < 1e-9);
  assert.equal(heights[3], 53 + MESH_LIFT_M);
});

test('refineHeights keeps bare earth under a deck with no road beside it, and rejects bad probes', () => {
  assert.deepEqual(
    refineHeights([
      { dem: 20, mesh: 35 },
      { dem: 20, mesh: 35 },
    ]),
    [20 + GROUND_CAST_LIFT_M, 20 + GROUND_CAST_LIFT_M],
  );
  // A probe kilometres under the ground is not a road.
  assert.deepEqual(refineHeights([{ dem: 20, mesh: -14000 }]), [
    20 + GROUND_CAST_LIFT_M,
  ]);
});

test('castLine refines heights with sampled mesh and densifies finer', async () => {
  const caster = createGroundCaster({ terrain: fakeTerrain(), step: 0.001 });
  const line = [
    [10.0001, 50.0001],
    [10.0009, 50.0001],
  ];
  await caster.prepareLines([line]);
  const plain = caster.castLine(line);
  const meshed = caster.castLine(line, { meshAt: () => 98 });
  assert.ok(meshed.length > plain.length, 'finer spacing with the mesh');
  for (let i = 2; i < meshed.length; i += 3)
    assert.equal(meshed[i], 98 + MESH_LIFT_M);
  // Unsampled points keep the bare-earth height.
  const unsampled = caster.castLine(line, { meshAt: () => undefined });
  assert.ok(unsampled[2] > 100 && unsampled[2] < 110);
});

test('a full cache is cleared before a request counts its corners, so the request still casts', async () => {
  const caster = createGroundCaster({
    terrain: fakeTerrain(),
    step: 0.001,
    maxCorners: 8,
    cacheMax: 5,
  });
  // One cell's four corners are cached...
  assert.equal(await caster.prepare([[10.0005, 50.0005]]), true);
  // ...then a line over that cell and the next needs two more, and the first
  // cell must survive the eviction.
  const line = [
    [10.0002, 50.0005],
    [10.0018, 50.0005],
  ];
  assert.equal(await caster.prepareLines([line]), true);
  assert.ok(caster.castLine(line), 'the whole line casts');
});

test('a full cache drops its oldest corners, not every corner', async () => {
  const caster = createGroundCaster({
    terrain: fakeTerrain(),
    step: 0.001,
    maxCorners: 4,
    cacheMax: 12,
  });
  // Three cells apart from each other, four corners each: the cache is full.
  const cells = [10.0005, 10.0105, 10.0205, 10.0305].map((lon) => [
    lon,
    50.0005,
  ]);
  for (const cell of cells.slice(0, 3))
    assert.equal(await caster.prepare([cell]), true);
  // A fourth makes room by dropping the first cell only.
  assert.equal(await caster.prepare([cells[3]]), true);
  assert.equal(caster.groundAt(...cells[0]), null, 'oldest dropped');
  for (const cell of cells.slice(1))
    assert.notEqual(caster.groundAt(...cell), null, 'newer cells kept');
});

test('cancelling a prepare cancels its terrain request', async () => {
  const seen = [];
  const caster = createGroundCaster({
    terrain: {
      async resolveEllipsoidalGround(coords, options) {
        seen.push(options?.signal);
        return coords.map(() => ({ ellipsoid: 100, source: 'reearth' }));
      },
    },
  });
  const controller = new AbortController();
  await caster.prepare([[10.0005, 50.0005]], { signal: controller.signal });
  assert.equal(seen.length, 1);
  assert.equal(seen[0], controller.signal, 'the tile signal reaches the proxy');
});

test('prepared lines always cast with the mesh, however their segments cross the grid', async () => {
  // Seeded walks with 50–300 m segments: the finer mesh points can land in
  // grid cells the coarse points skip.
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  let failures = 0;
  for (let n = 0; n < 300; n++) {
    const caster = createGroundCaster({ terrain: fakeTerrain() });
    const line = [[10 + random() * 0.01, 50 + random() * 0.01]];
    for (let k = 0; k < 10; k++) {
      const [lon, lat] = line[line.length - 1];
      const length = (50 + random() * 250) / 111_000;
      const angle = random() * 2 * Math.PI;
      line.push([
        lon + length * Math.cos(angle),
        lat + length * Math.sin(angle),
      ]);
    }
    assert.equal(await caster.prepareLines([line]), true);
    if (caster.castLine(line, { meshAt: () => undefined }) === null) failures++;
  }
  assert.equal(failures, 0);
});

test('a line across the date line casts along the date line', async () => {
  // Ground that rises northward only, so both sides of ±180° agree.
  const calls = [];
  const terrain = {
    async resolveEllipsoidalGround(coords) {
      calls.push(...coords);
      return coords.map(({ lat }) => ({
        ellipsoid: 100 + (lat - 50) * 2000,
        source: 'reearth',
      }));
    },
  };
  const caster = createGroundCaster({ terrain, step: 0.001 });
  const line = [
    [179.9995, 50.0005],
    [180, 50.0005],
    [-179.9995, 50.0005],
  ];
  assert.equal(await caster.prepareLines([line]), true);
  for (const meshAt of [null, () => undefined]) {
    const flat = caster.castLine(line, { meshAt });
    assert.ok(flat, 'every point casts');
    assert.ok(
      flat.length / 3 <= 8,
      `${flat.length / 3} points, not a line round the world`,
    );
    for (let i = 0; i < flat.length; i += 3) {
      assert.ok(Math.abs(flat[i]) >= 179.999 && Math.abs(flat[i]) <= 180);
      assert.ok(Math.abs(flat[i + 2] - (101 + GROUND_CAST_LIFT_M)) < 1e-6);
    }
  }
  // Only ground near the date line is asked for, and every longitude is a
  // real one (the far corner of a point on 180° is asked for at -179.999°).
  assert.ok(calls.length <= 16, `${calls.length} corners`);
  for (const { lon } of calls)
    assert.ok(Math.abs(lon) >= 179.999 && Math.abs(lon) <= 180, `${lon}`);
});
