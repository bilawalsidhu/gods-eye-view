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

test('the caster interpolates cached grid corners and adds the lift', async () => {
  const terrain = fakeTerrain();
  const caster = createGroundCaster({ terrain, step: 0.001 });
  assert.equal(caster.heightAt(10.0005, 50.0005), null);
  assert.equal(await caster.prepare([[10.0005, 50.0005]]), true);
  assert.equal(terrain.calls.length, 1);
  assert.equal(terrain.calls[0].length, 4);
  // Centre of the cell: mean of 100, 101, 102, 103.
  const height = caster.heightAt(10.0005, 50.0005);
  assert.ok(Math.abs(height - (101.5 + GROUND_CAST_LIFT_M)) < 1e-6);
  assert.ok(Math.abs(caster.groundAt(10.0005, 50.0005) - 101.5) < 1e-6);
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
  assert.equal(fallback.heightAt(10.0005, 50.0005), null);

  const down = createGroundCaster({ terrain: fakeTerrain({ fail: true }) });
  assert.equal(await down.prepare([[10.0005, 50.0005]]), false);
  assert.equal(down.heightAt(10.0005, 50.0005), null);
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
  // ...then a line over that cell and the next needs two more. Clearing after
  // counting would have kept only the two new corners and lost the first cell.
  const line = [
    [10.0002, 50.0005],
    [10.0018, 50.0005],
  ];
  assert.equal(await caster.prepareLines([line]), true);
  assert.ok(caster.castLine(line), 'the whole line casts');
});
