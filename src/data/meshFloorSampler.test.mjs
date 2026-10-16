// src/data/meshFloorSampler.test.mjs — the rendered-mesh sampler driven through
// its REAL validation boundary (2026-08-21).
//
// The sampler's acceptance rule was previously covered only through
// `reportValidatedMeshFloorCell` directly, which proves the gate but not the
// decision that feeds it. These tests call `sampleMeshFloorCells` with a fake
// globe engine whose surface answers what an engine can answer — a height,
// `undefined`, NaN, a throw, or a coarse tile — and assert that a cell
// latches if and only if a REAL DEM prior exists, the answer is fine enough
// and the sample fits its window.
//
// That requirement is the load-bearing one: this round built a tier that kept
// the reading when no prior existed, and measured it recording a coarse-LOD
// 20.6 m for ground that is really ~122 m (see meshFloorSampler.js). Without a
// prior there is nothing to tell a surface from a mis-hit, and `tilesLoaded`
// is not that signal.
//
// The DEM priors are seeded the same way `terrainHeights.test.mjs` does: a fake
// `globalThis.fetch` in front of the real resolver, so the module's own
// real-vs-fallback bookkeeping is exercised rather than stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { sampleMeshFloorCells } from './meshFloorSampler.js';
import { resolveEllipsoidalGround } from './terrainHeights.js';
import {
  cachedGroundFloor, cachedMeshFloor, setMeshFloorPreferred,
  _clearMeshFloorCellsForTest,
} from './groundFloor.js';

/** Distinct site per test — terrainHeights' cache is module-global and warm
 *  entries are permanent, so tests must not share coordinates. */
let siteLat = 40.0;
const nextSite = () => ({ lat: +(siteLat += 0.05).toFixed(3), lon: -97.66 });

/** Seeds a REAL ('reearth') DEM prior for a cell through the real resolver. */
async function seedDem(cell, ellipsoid) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ results: [{ ellipsoid }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    await resolveEllipsoidalGround([{ lat: cell.lat, lon: cell.lon }]);
  } finally {
    globalThis.fetch = original;
  }
}

/** A globe engine the sampler accepts: low camera over the cell, photoreal
 *  tiles loaded, and a surface under the test's control. */

async function fakeEngineAt(cell, { heightM = 900, tilesLoaded = true, photoreal = true, sample } = {}) {
  const { createFakeEngine } = await import('../globe/testing/fakeEngine.js');
  const engine = createFakeEngine({
    longitude: Cesium.Math.toRadians(cell.lon),
    latitude: Cesium.Math.toRadians(cell.lat),
    altitude: heightM,
  });
  if (photoreal) await engine.maps.setPhotorealTiles({ tileset: {} });
  engine.fake.script('tilesLoaded', tilesLoaded);
  engine.fake.script('sampleHeight', sample);
  return engine;
}

function reset() {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
}

test('sampler: a finite sample with NO DEM prior is stored NOWHERE', async () => {
  reset();
  const cell = nextSite();
  sampleMeshFloorCells(await fakeEngineAt(cell, { sample: () => 138.0 }), [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'nothing may latch without a prior');
  assert.equal(cachedGroundFloor(cell.lat, cell.lon), null, 'the shared choke point stays clean');
});

test('sampler: a finite sample WITH a fitting DEM prior latches and becomes the shared floor', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const engine = await fakeEngineAt(cell, { sample: () => 137.0 }); // +17 m of mesh over bare earth — in window
  sampleMeshFloorCells(engine, [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 137.0);
  assert.equal(cachedGroundFloor(cell.lat, cell.lon), 137.0, 'and it is what every consumer reads');
});

test('sampler: a sample REJECTED against a real prior is stored nowhere', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const engine = await fakeEngineAt(cell, { sample: () => 400.0 }); // a tower hit — far outside the +80 m window
  sampleMeshFloorCells(engine, [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null);
  assert.equal(cachedGroundFloor(cell.lat, cell.lon), 120.0, 'the DEM prior still answers');
});

test('sampler: undefined, NaN and a throwing probe latch nothing and crash nothing', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  for (const bad of [() => undefined, () => Number.NaN, () => { throw new Error('mid-teardown'); }]) {
    sampleMeshFloorCells(await fakeEngineAt(cell, { sample: bad }), [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
    assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'no negative latch, no throw');
  }
  sampleMeshFloorCells(await fakeEngineAt(cell, { sample: () => 133.0 }), [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 133.0, 'and a later good sample still lands');
});

test('sampler: a high camera or unloaded tiles produce no records at all', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  sampleMeshFloorCells(await fakeEngineAt(cell, { sample: () => 138.0, heightM: 90_000 }), [cell], opts);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'coarse LOD under a high camera');
  sampleMeshFloorCells(await fakeEngineAt(cell, { sample: () => 138.0, tilesLoaded: false }), [cell], opts);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'mid-stream tiles read coarse');
});

test('sampler: outside the google-3d regime nothing is sampled at all', async () => {
  reset();
  const cell = nextSite();
  setMeshFloorPreferred(false);
  let calls = 0;
  sampleMeshFloorCells(await fakeEngineAt(cell, { sample: () => { calls += 1; return 138.0; } }), [cell],
    { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(calls, 0, 'on a globe stack the DEM IS the rendered surface');
  setMeshFloorPreferred(true);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null);
});

test('sampler on a globe engine: samples engine.surface and latches against the prior', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const engine = await fakeEngineAt(cell, { sample: () => 137.0 });
  sampleMeshFloorCells(engine, [cell], { viewerLat: cell.lat, viewerLon: cell.lon, excludeObjects: ['own'] });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 137.0);
  const [call] = engine.fake.callsOf('surface.sampleHeightDetailed');
  assert.ok(Math.abs(Cesium.Math.toDegrees(call.args[0].latitude) - cell.lat) < 1e-9);
  assert.deepEqual(call.args[1], { exclude: ['own'], lod: 'visible' });
});

test('sampler: a coarse tile answer is a miss; a fine one latches', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  // Measured on Navara at Austin while the tiles streamed: a 28 km tile read
  // 143.2 m where the ground is 122.5 m (a 1.8 km tile).
  const engine = await fakeEngineAt(cell);
  engine.fake.script('sampleHeightDetailed', () => ({ height: 143.2, source: 'tiles', tileSizeM: 27_914 }));
  sampleMeshFloorCells(engine, [cell], opts);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'coarse: no latch');
  engine.fake.script('sampleHeightDetailed', () => ({ height: 122.5, source: 'tiles', tileSizeM: 1_797 }));
  sampleMeshFloorCells(engine, [cell], opts);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 122.5);
  const terrainOnly = nextSite();
  await seedDem(terrainOnly, 120.0);
  engine.fake.script('sampleHeightDetailed', () => ({ height: 121, source: 'terrain' }));
  sampleMeshFloorCells(engine, [terrainOnly], { viewerLat: terrainOnly.lat, viewerLon: terrainOnly.lon });
  assert.equal(cachedMeshFloor(terrainOnly.lat, terrainOnly.lon), null, 'terrain is not the mesh');
});

test('sampler on a globe engine: a high camera, loading tiles or no photoreal tiles sample nothing', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  for (const options of [{ heightM: 90_000 }, { tilesLoaded: false }, { photoreal: false }]) {
    const engine = await fakeEngineAt(cell, { ...options, sample: () => 138.0 });
    sampleMeshFloorCells(engine, [cell], opts);
    assert.equal(engine.fake.callsOf('surface.sampleHeightDetailed').length, 0, JSON.stringify(options));
  }
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null);
});
