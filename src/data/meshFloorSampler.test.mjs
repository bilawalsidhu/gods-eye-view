// src/data/meshFloorSampler.test.mjs — the rendered-mesh sampler driven through
// its REAL validation boundary (2026-08-21).
//
// The sampler's acceptance rule was previously covered only through
// `reportValidatedMeshFloorCell` directly, which proves the gate but not the
// decision that feeds it. These tests call `sampleMeshFloorCells` with a fake
// scene whose `sampleHeight` returns exactly what Cesium can return — a number,
// `undefined`, NaN, or a throw — and assert that a cell latches if and only if
// a REAL DEM prior exists and the sample fits its window.
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
  _clearMeshFloorCellsForTest, reportValidatedMeshFloorCell,
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

/** A scene the sampler accepts: low camera, one visible tileset reporting
 *  tilesLoaded, and a `sampleHeight` under the test's control. */
function fakeScene(sampleHeight, { cameraHeightM = 900, tilesLoaded = true, show = true } = {}) {
  // instanceof-compatible without running Cesium's constructor; `tilesLoaded` is
  // a prototype getter, so it has to be shadowed with an own data property.
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  Object.defineProperty(tileset, 'tilesLoaded', { value: tilesLoaded, configurable: true });
  Object.defineProperty(tileset, 'show', { value: show, configurable: true });
  return {
    sampleHeight,
    camera: { positionCartographic: { height: cameraHeightM } },
    primitives: { length: 1, get: () => tileset },
  };
}

function reset() {
  _clearMeshFloorCellsForTest();
  setMeshFloorPreferred(true);
}

test('sampler: a finite sample with NO DEM prior is stored NOWHERE', () => {
  reset();
  const cell = nextSite();
  sampleMeshFloorCells(fakeScene(() => 138.0), [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'nothing may latch without a prior');
  assert.equal(cachedGroundFloor(cell.lat, cell.lon), null, 'the shared choke point stays clean');
});

test('sampler: a finite sample WITH a fitting DEM prior latches and becomes the shared floor', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const scene = fakeScene(() => 137.0); // +17 m of mesh over bare earth — in window
  sampleMeshFloorCells(scene, [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 137.0);
  assert.equal(cachedGroundFloor(cell.lat, cell.lon), 137.0, 'and it is what every consumer reads');
});

test('sampler: a sample REJECTED against a real prior is stored nowhere', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const scene = fakeScene(() => 400.0); // a tower hit — far outside the +80 m window
  sampleMeshFloorCells(scene, [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null);
  assert.equal(cachedGroundFloor(cell.lat, cell.lon), 120.0, 'the DEM prior still answers');
});

test('sampler: undefined, NaN and a throwing probe latch nothing and crash nothing', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  for (const bad of [() => undefined, () => Number.NaN, () => { throw new Error('mid-teardown'); }]) {
    sampleMeshFloorCells(fakeScene(bad), [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
    assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'no negative latch, no throw');
  }
  sampleMeshFloorCells(fakeScene(() => 133.0), [cell], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 133.0, 'and a later good sample still lands');
});

test('sampler: a high camera or unloaded tiles produce no records at all', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  sampleMeshFloorCells(fakeScene(() => 138.0, { cameraHeightM: 90_000 }), [cell], opts);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'coarse LOD under a high camera');
  sampleMeshFloorCells(fakeScene(() => 138.0, { tilesLoaded: false }), [cell], opts);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'mid-stream tiles read coarse');
});

test('sampler: outside the google-3d regime nothing is sampled at all', () => {
  reset();
  const cell = nextSite();
  setMeshFloorPreferred(false);
  let calls = 0;
  sampleMeshFloorCells(fakeScene(() => { calls += 1; return 138.0; }), [cell],
    { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(calls, 0, 'on a globe stack the DEM IS the rendered surface');
  setMeshFloorPreferred(true);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null);
});

test('sampler: a cell just across the antimeridian is still near the viewer', () => {
  reset();
  let calls = 0;
  const scene = fakeScene(() => { calls += 1; return undefined; });
  sampleMeshFloorCells(scene, [{ lat: -16.8, lon: -179.999 }], { viewerLat: -16.8, viewerLon: 179.999 });
  sampleMeshFloorCells(scene, [{ lat: -16.81, lon: 179.999 }], { viewerLat: -16.81, viewerLon: -179.999 });
  assert.equal(calls, 2, 'about 200 m apart, so both cells are probed');
});

test('sampler: the probe goes where the point is, not to the cell centre', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  const asked = [];
  const scene = fakeScene((carto) => {
    asked.push(Cesium.Math.toDegrees(carto.longitude));
    return 122.0;
  });
  const point = { lat: cell.lat + 0.0003, lon: cell.lon + 0.0004 };
  sampleMeshFloorCells(scene, [point], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(asked.length, 1);
  assert.ok(Math.abs(asked[0] - point.lon) < 1e-9, `probed at ${asked[0]}, not ${point.lon}`);
});

test('sampler: a viaduct and the street beside it in one cell keep their own heights', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  // A viaduct deck 9 m up along one line of the cell, the street elsewhere.
  const deckLat = cell.lat + 0.0003;
  let calls = 0;
  const scene = fakeScene((carto) => {
    calls += 1;
    return Math.abs(Cesium.Math.toDegrees(carto.latitude) - deckLat) < 1e-7 ? 129.0 : 121.0;
  });
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  const onDeck = { lat: deckLat, lon: cell.lon };
  const street = { lat: cell.lat - 0.0003, lon: cell.lon };
  sampleMeshFloorCells(scene, [onDeck], opts);
  sampleMeshFloorCells(scene, [street], opts);
  assert.equal(calls, 2);
  assert.equal(cachedMeshFloor(onDeck.lat, onDeck.lon + 0.0001), 129.0, 'the train stays on the deck');
  assert.equal(cachedMeshFloor(street.lat, street.lon - 0.0001), 121.0, 'the bus stays on the street');
  assert.equal(cachedGroundFloor(street.lat, street.lon), 121.0);
  sampleMeshFloorCells(scene, [{ lat: deckLat, lon: cell.lon + 0.00001 }], opts);
  assert.equal(calls, 2, 'a point next to one already probed is not probed again');
});

test('sampler: a roof over the cell centre does not lift a bus on the street', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  // A roof 22 m up covering the cell's centre; the street 30 m west of it.
  const scene = fakeScene((carto) =>
    Math.abs(Cesium.Math.toDegrees(carto.longitude) - cell.lon) < 0.0001 ? 142.0 : 121.0);
  const bus = { lat: cell.lat, lon: cell.lon - 0.0003 };
  sampleMeshFloorCells(scene, [bus], { viewerLat: cell.lat, viewerLon: cell.lon });
  assert.equal(cachedGroundFloor(bus.lat, bus.lon), 121.0);
});

test('sampler: a second reading at the same spot keeps the lower one', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  assert.equal(reportValidatedMeshFloorCell(cell.lat, cell.lon, 131.0), true);
  assert.equal(reportValidatedMeshFloorCell(cell.lat + 0.00002, cell.lon, 122.0), true);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 122.0);
  assert.equal(reportValidatedMeshFloorCell(cell.lat, cell.lon + 0.00002, 140.0), true);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 122.0, 'a higher one never raises it');
});

test('sampler: a cell with a reading is probed a few times at most', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  let calls = 0;
  const scene = fakeScene(() => {
    calls += 1;
    return 121.0;
  });
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  for (let i = 0; i < 20; i++)
    sampleMeshFloorCells(
      scene,
      [{ lat: cell.lat - 0.0004 + (i % 5) * 0.0002, lon: cell.lon - 0.00045 + Math.floor(i / 5) * 0.0003 }],
      opts,
    );
  assert.equal(calls, 8);
});

test('sampler: a cell with no accepted reading is probed again on every call', async () => {
  reset();
  const cell = nextSite();
  let calls = 0;
  const scene = fakeScene(() => {
    calls += 1;
    return 138.0;
  });
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  for (let i = 0; i < 3; i++) sampleMeshFloorCells(scene, [cell], opts);
  assert.equal(calls, 3, 'no DEM prior yet, so nothing is kept and the cell is retried');
  await seedDem(cell, 120.0);
  sampleMeshFloorCells(scene, [cell], opts);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), 138.0, 'and lands once the prior is warm');
});

test('sampler: a spot whose reading is refused does not use up the cell', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  // A tower 260 m up where the first vehicle waits; the street elsewhere and
  // a deck 9 m up along one line of the cell.
  const towerLon = cell.lon + 0.0004;
  const deckLat = cell.lat + 0.0003;
  const scene = fakeScene((carto) => {
    if (Math.abs(Cesium.Math.toDegrees(carto.longitude) - towerLon) < 1e-7) return 380.0;
    return Math.abs(Cesium.Math.toDegrees(carto.latitude) - deckLat) < 1e-7 ? 129.0 : 121.0;
  });
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  for (let i = 0; i < 10; i++) sampleMeshFloorCells(scene, [{ lat: cell.lat, lon: towerLon }], opts);
  assert.equal(cachedMeshFloor(cell.lat, cell.lon), null, 'the tower is refused every time');
  sampleMeshFloorCells(scene, [{ lat: cell.lat - 0.0003, lon: cell.lon }], opts);
  sampleMeshFloorCells(scene, [{ lat: deckLat, lon: cell.lon - 0.0003 }], opts);
  assert.equal(cachedMeshFloor(deckLat, cell.lon - 0.0003), 129.0, 'the deck is still probed');
});

test('ground floor: a cell keeps at most sixteen readings', async () => {
  reset();
  const cell = nextSite();
  await seedDem(cell, 120.0);
  for (let i = 0; i < 40; i++) {
    const lat = cell.lat - 0.00045 + (i % 8) * 0.0001;
    const lon = cell.lon - 0.00045 + Math.floor(i / 8) * 0.0002;
    reportValidatedMeshFloorCell(lat, lon, 121.0 + i);
  }
  // Readings 0..15 are kept; reading 39 (at the far corner) is not, so that
  // spot answers from the nearest kept one.
  assert.equal(cachedMeshFloor(cell.lat - 0.00045, cell.lon - 0.00045), 121.0);
  assert.equal(cachedMeshFloor(cell.lat + 0.00025, cell.lon + 0.00035), 121.0 + 15);
});

test('sampler: a spot refused while the DEM was cold is probed again once it is warm', async () => {
  reset();
  const cell = nextSite();
  const deckLat = cell.lat + 0.0003;
  let calls = 0;
  const scene = fakeScene((carto) => {
    calls += 1;
    return Math.abs(Cesium.Math.toDegrees(carto.latitude) - deckLat) < 1e-7 ? 129.0 : 121.0;
  });
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  const onDeck = { lat: deckLat, lon: cell.lon };
  sampleMeshFloorCells(scene, [onDeck], opts);
  assert.equal(cachedMeshFloor(onDeck.lat, onDeck.lon), null, 'no prior, nothing kept');
  await seedDem(cell, 120.0);
  sampleMeshFloorCells(scene, [{ lat: cell.lat - 0.0003, lon: cell.lon }], opts);
  sampleMeshFloorCells(scene, [onDeck], opts);
  assert.equal(calls, 3);
  assert.equal(cachedMeshFloor(onDeck.lat, onDeck.lon), 129.0);
});

test('sampler: a spot refused while the DEM prior was evicted is probed again', async () => {
  const { createGroundFloor } = await import('../services/groundFloor.js');
  const { createMeshFloorSampler } = await import('../services/meshFloorSampler.js');
  let prior = 120.0;
  const terrain = {
    cachedRealEllipsoidalGround: () => prior,
    resolveEllipsoidalGround: async () => {},
  };
  const groundFloor = createGroundFloor({ terrain });
  const sampler = createMeshFloorSampler({ groundFloor });
  const cell = { lat: 41.5, lon: -97.66 };
  const deckLat = cell.lat + 0.0003;
  const scene = fakeScene((carto) =>
    Math.abs(Cesium.Math.toDegrees(carto.latitude) - deckLat) < 1e-7 ? 129.0 : 121.0);
  const opts = { viewerLat: cell.lat, viewerLon: cell.lon };
  const onDeck = { lat: deckLat, lon: cell.lon };
  sampler.sampleMeshFloorCells(scene, [{ lat: cell.lat - 0.0003, lon: cell.lon }], opts);
  prior = null; // the cell's DEM entry is evicted; the street reading stays
  sampler.sampleMeshFloorCells(scene, [onDeck], opts);
  assert.equal(groundFloor.cachedMeshFloor(onDeck.lat, onDeck.lon), 121.0);
  prior = 120.0;
  sampler.sampleMeshFloorCells(scene, [onDeck], opts);
  assert.equal(groundFloor.cachedMeshFloor(onDeck.lat, onDeck.lon), 129.0);
});
