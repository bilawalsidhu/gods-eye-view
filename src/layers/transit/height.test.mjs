import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createHeight } from './height.js';
import {
  FLOOR_REREAD_ATTEMPTS,
  FLOOR_REREAD_MS,
  TERRAIN_HEIGHT_CACHE_MAX,
  TERRAIN_HEIGHT_FRESH_MS,
  TERRAIN_NEED,
  TERRAIN_READ_BUDGET_MS,
  TERRAIN_READ_WINDOW_MS,
  TERRAIN_REFRESH_BUDGET_MS,
  TERRAIN_SETTLE_MS,
} from './policy.js';

const LIFT = 1.5;

/**
 * A height part over a terrain globe whose every read costs `costMs` of a
 * clock the test owns. `surface(lat, lon)` is the terrain; `reads` lists the
 * points actually read.
 */
function terrain(t, { costMs = 0, surface = () => 100, provider = {} } = {}) {
  const clock = { now: 1_000_000 };
  t.mock.method(performance, 'now', () => clock.now);
  const reads = [];
  const world = { surface, costMs };
  const globe = {
    show: true,
    getHeight(point) {
      const lat = Cesium.Math.toDegrees(point.latitude);
      const lon = Cesium.Math.toDegrees(point.longitude);
      reads.push(`${lat.toFixed(5)},${lon.toFixed(5)}`);
      clock.now += world.costMs;
      return world.surface(lat, lon);
    },
  };
  const state = {
    _enabled: true,
    _selectedKey: null,
    _vehicles: new Map(),
    _visible: new Set(),
    _floorCursor: 0,
    _floorAttempts: 0,
    _floorTimer: null,
    _heightDirty: new Set(),
    _viewer: {
      camera: { positionCartographic: { height: 500 } },
      scene: { globe },
      terrainProvider: provider,
    },
  };
  const parts = {
    trails: { prepareEntry() {} },
    rendering: { requestVisibility() {} },
  };
  const height = createHeight({
    state,
    services: {
      render: { governorRequestRender() {} },
      ground: {
        coarseFloorCoord: (lat, lon) => ({
          lat: Number(lat.toFixed(3)),
          lon: Number(lon.toFixed(3)),
        }),
        cachedGroundFloor: () => null,
        neighborFloorM: () => null,
        warmGroundFloor() {},
        GROUND_FLOOR_LIFT_M: LIFT,
      },
    },
    parts,
  });
  t.after(() => height.clear());
  const nextWindow = () => {
    clock.now += TERRAIN_READ_WINDOW_MS;
  };
  return { height, state, parts, globe, world, clock, reads, nextWindow };
}

test('a point is read from the terrain once and reused until its reuse time passes', (t) => {
  const { height, reads, clock, world } = terrain(t);
  const first = height.requestHeight(42.36, -71.06);
  assert.deepEqual(first, { cell: '42.36,-71.06', height: 100 + LIFT, prior: null });
  for (let i = 0; i < 500; i++) height.requestHeight(42.36, -71.06);
  assert.equal(reads.length, 1, '501 requests, one terrain read');

  // A point a metre away is its own point; the same cell does not stand in
  // for it while the budget allows a read.
  world.surface = (lat) => (lat > 42.36 ? 140 : 100);
  assert.equal(height.requestHeight(42.36002, -71.06).height, 140 + LIFT);
  assert.equal(reads.length, 2);

  // The surface under the first point changed (the globe drew a finer tile).
  world.surface = () => 120;
  clock.now += TERRAIN_HEIGHT_FRESH_MS - 1;
  assert.equal(height.requestHeight(42.36, -71.06).height, 100 + LIFT);
  clock.now += 1;
  assert.equal(height.requestHeight(42.36, -71.06).height, 120 + LIFT);
  assert.equal(reads.length, 3);
  assert.deepEqual(height.terrainStats(), {
    reads: 3,
    reused: 501,
    deferred: 0,
    borrowed: 0,
    held: 2,
  });
});

test('terrain that is not loaded yet is not remembered as an answer', (t) => {
  const { height, reads, world } = terrain(t, { surface: () => undefined });
  assert.deepEqual(height.requestHeight(42.36, -71.06), {
    cell: '42.36,-71.06',
    height: null,
    prior: null,
  });
  assert.equal(height.requestHeight(42.36, -71.06).height, null);
  assert.equal(reads.length, 2, 'each request asks again');
  world.surface = () => 12;
  assert.equal(height.requestHeight(42.36, -71.06).height, 12 + LIFT);
  assert.equal(height.terrainStats().held, 1);
});

test('a tile that leaves the globe keeps the height it gave', (t) => {
  const { height, clock, world } = terrain(t, { surface: () => 30 });
  assert.equal(height.requestHeight(42.36, -71.06).height, 30 + LIFT);
  world.surface = () => undefined;
  clock.now += TERRAIN_HEIGHT_FRESH_MS * 20;
  assert.equal(height.requestHeight(42.36, -71.06).height, 30 + LIFT);
});

test('new points stop being read once a window has spent its budget', (t) => {
  const costMs = 5;
  const { height, reads, nextWindow } = terrain(t, {
    costMs,
    surface: (lat, lon) => Math.round(lon * -1000),
  });
  const affordable = Math.ceil(TERRAIN_READ_BUDGET_MS / costMs);
  // One point per floor cell (0.001° apart), more than the window affords.
  const answers = [];
  for (let i = 0; i < affordable + 3; i++)
    answers.push(height.requestHeight(42.36, -71.06 - i * 0.001).height);
  assert.equal(reads.length, affordable);
  assert.deepEqual(
    answers.slice(affordable),
    [null, null, null],
    'a point in a cell never read waits',
  );
  assert.ok(reads.length * costMs < TERRAIN_READ_BUDGET_MS + costMs, 'the overrun is one read at most');

  // A new point in a cell that was read borrows that cell's height.
  const borrowed = height.requestHeight(42.36004, -71.06);
  assert.equal(borrowed.height, 71060 + LIFT);
  assert.equal(reads.length, affordable, 'borrowing reads nothing');
  assert.equal(height.terrainStats().borrowed, 1);

  // The next window reads the points that waited, and the borrower its own.
  nextWindow();
  for (let i = affordable; i < affordable + 3; i++)
    assert.equal(
      height.requestHeight(42.36, -71.06 - i * 0.001).height,
      Math.round((-71.06 - i * 0.001) * -1000) + LIFT,
    );
  assert.equal(reads.length, affordable + 3);
});

test("a vehicle's own position is read even when the window is spent", (t) => {
  const { height, reads } = terrain(t, { costMs: TERRAIN_READ_BUDGET_MS });
  height.requestHeight(42.36, -71.06);
  assert.equal(height.requestHeight(42.37, -71.07).height, null, 'a trail point waits');
  assert.equal(height.requestHeight(42.38, -71.08, null, TERRAIN_NEED.MARKER).height, 100 + LIFT);
  assert.equal(reads.length, 2);
});

test('undrawn trail history leaves most of the budget to the paths markers are drawn along', (t) => {
  const costMs = 1;
  const { height, reads } = terrain(t, { costMs });
  // New points, one per floor cell: history first, as a pass offers them.
  let lon = -71;
  const ask = (need) => height.requestHeight(42, (lon -= 0.001), null, need).height;
  const history = Array.from({ length: 30 }, () => ask(TERRAIN_NEED.HISTORY));
  const read = history.filter((h) => h !== null).length;
  assert.equal(read, TERRAIN_READ_BUDGET_MS / 4, 'history stops at a quarter of the budget');
  const path = Array.from({ length: 30 }, () => ask(TERRAIN_NEED.PATH));
  assert.equal(path.filter((h) => h !== null).length, TERRAIN_READ_BUDGET_MS - read, 'the path takes the rest');
  assert.equal(ask(TERRAIN_NEED.HISTORY), null);
  assert.equal(ask(TERRAIN_NEED.MARKER), 100 + LIFT, 'a marker is still read');
  assert.equal(reads.length, TERRAIN_READ_BUDGET_MS + 1);
});

test('held points keep their last height while re-reads are over budget, and the longest-held are re-read first so none starves', (t) => {
  const costMs = TERRAIN_REFRESH_BUDGET_MS / 2;
  const { height, reads, clock, world, nextWindow } = terrain(t, { surface: () => 50 });
  const points = Array.from({ length: 40 }, (_, i) => [42.36, -71.06 - i * 0.001]);
  for (const [lat, lon] of points) height.requestHeight(lat, lon);
  assert.equal(reads.length, 40);

  world.costMs = costMs;
  world.surface = () => 80;
  clock.now += TERRAIN_HEIGHT_FRESH_MS;
  reads.length = 0;
  const pass = () => points.map(([lat, lon]) => height.requestHeight(lat, lon).height);
  const first = pass();
  const perWindow = Math.ceil(TERRAIN_REFRESH_BUDGET_MS / costMs);
  assert.equal(reads.length, perWindow, 'one window re-reads its budget and no more');
  assert.deepEqual(first.slice(0, perWindow), Array(perWindow).fill(80 + LIFT));
  assert.deepEqual(first.slice(perWindow), Array(40 - perWindow).fill(50 + LIFT), 'the rest keep their last height');

  // Pass after pass, a window apart: the budget moves down the list instead
  // of returning to the first points, whose reuse time runs out again long
  // before the last ones have had a turn (40 points, ${perWindow} a window).
  const turns = new Map();
  for (const point of reads) turns.set(point, 1);
  const cycle = Math.ceil(40 / perWindow);
  for (let passes = 1; passes < cycle; passes++) {
    nextWindow();
    reads.length = 0;
    pass();
    for (const point of reads) turns.set(point, (turns.get(point) || 0) + 1);
  }
  assert.equal(turns.size, 40, 'every point was re-read in one cycle');
  assert.ok([...turns.values()].every((count) => count === 1), 'and none twice before the others once');
  assert.ok(cycle * TERRAIN_READ_WINDOW_MS > TERRAIN_HEIGHT_FRESH_MS, 'the cycle is longer than the reuse time, so the first points were stale again');
  assert.deepEqual(pass().slice(-1), [80 + LIFT]);
});

test('once the camera and the tiles have settled a height is kept until either changes', (t) => {
  const { height, state, globe, reads, clock, world } = terrain(t, { surface: () => 10 });
  const read = () => height.requestHeight(42.36, -71.06).height;
  assert.equal(read(), 10 + LIFT);
  // Still settling: the point falls due and is read again.
  world.surface = () => 20;
  clock.now += TERRAIN_SETTLE_MS;
  assert.equal(read(), 20 + LIFT);
  assert.equal(reads.length, 2);
  // Read after the settle time: kept, however long the view stays put.
  world.surface = () => 99;
  for (let i = 0; i < 50; i++) {
    clock.now += 60_000;
    assert.equal(read(), 20 + LIFT);
  }
  assert.equal(reads.length, 2);

  // The camera moves: the globe may draw the point from a finer tile.
  state._viewer.camera.positionCartographic = { longitude: 0, latitude: 0, height: 250 };
  clock.now += TERRAIN_READ_WINDOW_MS;
  assert.equal(read(), 99 + LIFT);
  assert.equal(reads.length, 3);

  // Settled again, then a tile starts loading with the camera still.
  world.surface = () => 101;
  clock.now += TERRAIN_SETTLE_MS;
  assert.equal(read(), 101 + LIFT);
  clock.now += 60_000;
  assert.equal(read(), 101 + LIFT);
  assert.equal(reads.length, 4);
  world.surface = () => 105;
  globe.tilesLoaded = false;
  clock.now += TERRAIN_READ_WINDOW_MS;
  assert.equal(read(), 105 + LIFT);
  assert.equal(reads.length, 5);
});

test('another terrain provider or globe is read afresh, however settled the old heights were', (t) => {
  const { height, state, globe, world, clock, reads } = terrain(t);
  const viewer = state._viewer;
  const at = () => height.requestHeight(42.36, -71.06).height;
  // Read once the camera and tiles have long settled: kept indefinitely.
  height.requestHeight(10, 10);
  clock.now += TERRAIN_SETTLE_MS * 2;
  reads.length = 0;
  assert.equal(at(), 100 + LIFT);
  clock.now += TERRAIN_SETTLE_MS * 10;
  world.surface = () => 250;
  assert.equal(at(), 100 + LIFT, 'same terrain: the kept height stands');
  assert.equal(reads.length, 1);

  viewer.terrainProvider = {};
  assert.equal(at(), 250 + LIFT, 'a new provider is a new surface');
  assert.equal(reads.length, 2);

  world.surface = () => 400;
  viewer.scene.globe = { show: true, getHeight: globe.getHeight };
  assert.equal(at(), 400 + LIFT, 'and so is a new globe');
  assert.equal(reads.length, 3);

  // Terrain → flat → the same terrain provider: nothing asks the terrain
  // while the globe is flat, yet the old heights must not come back.
  const real = viewer.terrainProvider;
  viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
  assert.equal(at(), LIFT);
  world.surface = () => 30;
  viewer.terrainProvider = real;
  assert.equal(at(), 30 + LIFT);
  assert.equal(reads.length, 4);
});

test('a flat globe answers without reading terrain', (t) => {
  const { height, reads } = terrain(t, {
    provider: new Cesium.EllipsoidTerrainProvider(),
  });
  assert.deepEqual(height.requestHeight(42.36, -71.06), {
    cell: '42.36,-71.06',
    height: LIFT,
    prior: null,
  });
  assert.equal(reads.length, 0);
});

test('a hidden globe reads no terrain and clear() forgets what was read', (t) => {
  const { height, reads, globe } = terrain(t);
  height.requestHeight(42.36, -71.06);
  height.clear();
  assert.equal(height.terrainStats().held, 0);
  height.requestHeight(42.36, -71.06);
  assert.equal(reads.length, 2, 'a cleared layer reads again');
  globe.show = false;
  assert.equal(height.requestHeight(42.5, -71.5).height, null);
  assert.equal(reads.length, 2);
});

test('the points kept stay bounded', (t) => {
  const { height } = terrain(t);
  const total = TERRAIN_HEIGHT_CACHE_MAX + 5_000;
  for (let i = 0; i < total; i++)
    height.requestHeight(10 + Math.floor(i / 1000) * 0.001, 20 + (i % 1000) * 0.0001);
  const { held, reads } = height.terrainStats();
  assert.equal(reads, total);
  assert.ok(held <= TERRAIN_HEIGHT_CACHE_MAX, `${held} held`);
  assert.ok(held >= TERRAIN_HEIGHT_CACHE_MAX * 0.7, `${held} held`);
});

test('a fleet rereading every trail fix reads each point once, not once per request', (t) => {
  const { height, state, parts, reads } = terrain(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // 600 vehicles with 40 fixes each, 25 m apart along a street.
  const fleet = Array.from({ length: 600 }, (_, v) => ({
    key: `bus-${v}`,
    fixes: Array.from({ length: 40 }, (_, i) => ({
      lat: 42 + v * 0.002,
      lon: -71 + i * 0.0003,
    })),
  }));
  for (const entry of fleet) {
    state._vehicles.set(entry.key, entry);
    state._visible.add(entry);
  }
  let requests = 0;
  parts.trails.prepareEntry = (entry, collect) => {
    for (const fix of entry.fixes) {
      requests++;
      const answer = height.requestHeight(fix.lat, fix.lon, entry);
      if (collect) collect(fix, answer);
    }
  };
  height.anchorFloors();
  for (let i = 0; i < FLOOR_REREAD_ATTEMPTS; i++) t.mock.timers.tick(FLOOR_REREAD_MS);
  assert.equal(requests, 600 * 40 * 2 * (FLOOR_REREAD_ATTEMPTS + 1));
  assert.equal(new Set(reads).size, 600 * 40);
  assert.equal(reads.length, 600 * 40, `${requests} requests, ${reads.length} terrain reads`);
  assert.ok(fleet.every((entry) => entry.heightM === 100 + LIFT && entry.heightResolved));
});

test('a reread cycle outlasts its attempts while trail points still wait for a read, then stops', (t) => {
  const costMs = 4;
  const { height, state, parts, reads, clock } = terrain(t, { costMs });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entry = {
    key: 'bus',
    // One fix per floor cell, so nothing can be borrowed.
    fixes: Array.from({ length: 60 }, (_, i) => ({ lat: 42, lon: -71 + i * 0.001 })),
  };
  state._vehicles.set(entry.key, entry);
  state._visible.add(entry);
  parts.trails.prepareEntry = (e) => {
    for (const fix of e.fixes) height.requestHeight(fix.lat, fix.lon, e);
  };
  height.anchorFloors();
  let passes = 1;
  while (state._floorTimer && passes < 200) {
    clock.now += FLOOR_REREAD_MS;
    t.mock.timers.tick(FLOOR_REREAD_MS);
    passes++;
  }
  assert.equal(new Set(reads).size, 60, 'every fix was read in the end');
  assert.ok(passes > FLOOR_REREAD_ATTEMPTS + 1, `${passes} passes: the cycle kept going for the unread fixes`);
  assert.ok(passes < 120, `${passes} passes: and stopped once none waited`);
  assert.equal(state._floorTimer, null);
});
