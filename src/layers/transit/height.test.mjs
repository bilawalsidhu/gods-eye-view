import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeight } from './height.js';
import { createTrack, insertFix } from '../../data/contactPlayback.js';
import { bindRenderer } from '../../render/rendererOf.js';
import {
  FLOOR_REREAD_ATTEMPTS,
  FLOOR_REREAD_MAX_ATTEMPTS,
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

function trackOf(fix) {
  const track = createTrack();
  insertFix(track, { t: 1, lat: fix.lat, lon: fix.lon });
  return track;
}

function addEntry(state, key, newest) {
  const entry = { key, fixes: [newest], track: trackOf(newest) };
  state._vehicles.set(key, entry);
  state._visible.add(entry);
  return entry;
}

/**
 * A height part over a terrain globe whose every read costs `costMs` of a
 * clock the test owns. `surface(lat, lon)` is the terrain; `reads` lists the
 * points actually read. `globe` is what the rendering part says of the
 * globe: what it draws, its surface version, whether its terrain tiles have
 * loaded, and the camera's pose.
 */
function terrain(t, { costMs = 0, surface = () => 100, drawn = 'terrain' } = {}) {
  const clock = { now: 1_000_000 };
  t.mock.method(performance, 'now', () => clock.now);
  const reads = [];
  const warmed = [];
  const world = { surface, costMs, cost: null, onRead: null };
  const globe = {
    drawn,
    terrain: 'A',
    settled: true,
    camera: { lon: 0, lat: 0, height: 500 },
  };
  // Read lazily, as the globe port reads it: the version moves only when
  // it is asked and what is shown differs from the last time.
  let surfaceSeen = null,
    version = 0;
  const surfaceVersion = () => {
    const shown = `${globe.drawn === 'none' ? 'hidden' : 'shown'}:${globe.terrain}`;
    if (shown !== surfaceSeen) {
      surfaceSeen = shown;
      version++;
    }
    return version;
  };
  const viewer = {};
  t.after(
    bindRenderer(viewer, {
      query: {
        sampleHeightNow({ lon, lat }, { against }) {
          assert.equal(against, 'terrain');
          reads.push(`${lat.toFixed(5)},${lon.toFixed(5)}`);
          world.onRead?.(lat, lon);
          clock.now += world.cost ? world.cost(lat, lon) : world.costMs;
          return world.surface(lat, lon);
        },
      },
    }),
  );
  const state = {
    _enabled: true,
    _selectedKey: null,
    _vehicles: new Map(),
    _visible: new Set(),
    _floorCursor: 0,
    _floorAttempts: 0,
    _floorTimer: null,
    _heightDirty: new Set(),
    _viewer: viewer,
  };
  const parts = {
    trails: { prepareEntry() {} },
    rendering: {
      requestVisibility() {},
      sampleMeshFloors() {},
      cameraPose: () => globe.camera,
      cameraHeightM: () => globe.camera.height,
      globeSurface: () => globe.drawn,
      surfaceVersion,
      terrainSettled: () => globe.settled,
    },
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
        warmGroundFloor(batch) {
          for (const point of batch) warmed.push(point.cell);
        },
        GROUND_FLOOR_LIFT_M: LIFT,
      },
    },
    parts,
  });
  t.after(() => height.clear());
  const nextWindow = () => {
    clock.now += TERRAIN_READ_WINDOW_MS;
  };
  return { height, state, parts, globe, world, clock, reads, warmed, nextWindow };
}

test('a point is read from the terrain once and reused until its reuse time passes', (t) => {
  const { height, reads, clock, world } = terrain(t);
  const first = height.requestHeight(42.36, -71.06);
  assert.deepEqual(first, { cell: '42.36,-71.06', height: 100 + LIFT, prior: null });
  for (let i = 0; i < 500; i++) height.requestHeight(42.36, -71.06);
  assert.equal(reads.length, 1, '501 requests, one terrain read');

  // A point two metres away is its own point; the same cell does not stand in
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
  assert.equal(height.requestHeight(42.36, -71.06).height, 12 + LIFT);
  assert.equal(reads.length, 3, 'the answer is kept once there is one');
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

  // The next window reads the points that waited, and the borrower its own.
  nextWindow();
  for (let i = affordable; i < affordable + 3; i++)
    assert.equal(
      height.requestHeight(42.36, -71.06 - i * 0.001).height,
      Math.round((-71.06 - i * 0.001) * -1000) + LIFT,
    );
  assert.equal(reads.length, affordable + 3);
});

test("a vehicle's own position is read past the budget while it has no kept height", (t) => {
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
  // First reads cost time too, so no two points share a read time.
  const { height, reads, clock, world, nextWindow } = terrain(t, { costMs: 0.1, surface: () => 50 });
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
  // before the last ones have had a turn (40 points, perWindow a window).
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
  const { height, globe, reads, clock, world } = terrain(t, { surface: () => 10 });
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
  globe.camera = { lon: 0, lat: 0, height: 250 };
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
  globe.settled = false;
  clock.now += TERRAIN_READ_WINDOW_MS;
  assert.equal(read(), 105 + LIFT);
  assert.equal(reads.length, 5);
});

test('another surface is read afresh, however settled the old heights were', (t) => {
  const { height, globe, world, clock, reads } = terrain(t);
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

  globe.terrain = 'B';
  assert.equal(at(), 250 + LIFT, 'a new terrain is a new surface');
  assert.equal(reads.length, 2);

  // Terrain → flat → the same terrain: nothing asks the terrain while the
  // globe is flat, yet the old heights must not come back.
  globe.drawn = 'flat';
  globe.terrain = 'ellipsoid';
  assert.equal(at(), LIFT);
  world.surface = () => 30;
  globe.drawn = 'terrain';
  globe.terrain = 'B';
  assert.equal(at(), 30 + LIFT);
  assert.equal(reads.length, 3);

  // Hidden and shown again over the same terrain: the version is read
  // while hidden too, so the heights are read again.
  world.surface = () => 40;
  globe.drawn = 'none';
  assert.equal(at(), null);
  globe.drawn = 'terrain';
  assert.equal(at(), 40 + LIFT);
  assert.equal(reads.length, 4);
});

test('clear() forgets what was read', (t) => {
  const { height, reads } = terrain(t);
  height.requestHeight(42.36, -71.06);
  height.clear();
  height.requestHeight(42.36, -71.06);
  assert.equal(reads.length, 2, 'a cleared layer reads again');
});

test('the points kept stay bounded', (t) => {
  const { height, reads } = terrain(t);
  const total = TERRAIN_HEIGHT_CACHE_MAX + 5_000;
  const at = (i) => height.requestHeight(10 + Math.floor(i / 1000) * 0.001, 20 + (i % 1000) * 0.0001);
  for (let i = 0; i < total; i++) at(i);
  assert.equal(reads.length, total);
  at(total - Math.ceil(TERRAIN_HEIGHT_CACHE_MAX * 0.7));
  assert.equal(reads.length, total, 'the newest 70% are still kept');
  at(0);
  assert.equal(reads.length, total + 1, 'the oldest were dropped');
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
    entry.track = trackOf(entry.fixes.at(-1));
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
  const costMs = 1;
  const { height, state, parts, reads, clock } = terrain(t, { costMs });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entry = {
    key: 'bus',
    // One fix per floor cell, so nothing can be borrowed.
    fixes: Array.from({ length: 60 }, (_, i) => ({ lat: 42, lon: -71 + i * 0.001 })),
  };
  entry.track = trackOf(entry.fixes.at(-1));
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
  assert.ok(passes <= FLOOR_REREAD_MAX_ATTEMPTS + 1, `${passes} passes: and stopped`);
  assert.equal(state._floorTimer, null);
});

test('a reread cycle stops at its cap while drawn points keep waiting', (t) => {
  const { height, state, parts, clock } = terrain(t, { costMs: TERRAIN_READ_BUDGET_MS });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entry = {
    key: 'bus',
    fixes: Array.from({ length: 60 }, (_, i) => ({ lat: 42, lon: -71 + i * 0.001 })),
  };
  entry.track = trackOf(entry.fixes.at(-1));
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
  assert.equal(passes, FLOOR_REREAD_MAX_ATTEMPTS + 1);
  assert.equal(height.requestHeight(43, -72).height, null, 'another drawn point still waits');
  assert.equal(state._floorTimer, null, 'an outside request respects the same cap');
});

test('re-reads move down the list when first reads have distinct times', (t) => {
  const { height, globe, reads, clock, world, nextWindow } = terrain(t, {
    costMs: 1 / 128,
    surface: () => 10,
  });
  const points = Array.from({ length: 100 }, (_, i) => [42.36, -71.06 - i * 0.001]);
  for (const [lat, lon] of points) height.requestHeight(lat, lon);
  assert.equal(reads.length, 100, 'all first reads fit one window');
  // A zoom, seen by a probe read, then a finer surface.
  world.costMs = 0;
  globe.camera = { lon: 0, lat: 0, height: 250 };
  nextWindow();
  height.requestHeight(10, 10);
  world.surface = () => 30;
  world.costMs = 0.5;
  clock.now += TERRAIN_SETTLE_MS + 1;
  const perSweep = [];
  let last;
  for (let sweep = 0; sweep < 5; sweep++) {
    reads.length = 0;
    last = points.map(([lat, lon]) => height.requestHeight(lat, lon).height);
    perSweep.push(reads.length);
    clock.now += 900;
  }
  const stale = last.filter((h) => h !== 30 + LIFT).length;
  assert.equal(
    stale,
    0,
    `re-reads per 900 ms sweep: ${perSweep.join(',')}; ${stale} of 100 points still at the old height after 5 sweeps (12 ms affords 24 re-reads a window)`,
  );
});

test('marker reads leave the drawn path half of the window', (t) => {
  const { height, world, nextWindow } = terrain(t);
  nextWindow();
  world.cost = () => 4;
  // New positions read at MARKER (unbudgeted while unheld): ingestion of
  // offscreen updates, the newest-fix prepass, or a selected trail's history.
  for (let i = 0; i < 4; i++) height.requestHeight(43 + i * 0.01, -70, null, TERRAIN_NEED.MARKER);
  // A visible moving bus's corridor interior vertex, in a cell nobody read,
  // terrain loaded, DEM and neighbour caches empty.
  const answer = height.requestHeight(42.3005, -71.3005);
  // null makes trails.prepareEntry drop the segment from displayPaths, so
  // samplePosition returns null and placeSample hides the marker.
  assert.notEqual(answer.height, null, 'the drawn corridor must not lose its vertex to the budget');
});

test('a cell keeps lending its height after points elsewhere are dropped', (t) => {
  const { height, world, reads, nextWindow } = terrain(t);
  for (let i = 0; i < TERRAIN_HEIGHT_CACHE_MAX - 1; i++)
    height.requestHeight(-30 + Math.floor(i / 1000) * 0.0001, 100 + (i % 1000) * 0.0001);
  nextWindow();
  world.surface = () => 80;
  world.cost = () => 16;
  assert.equal(height.requestHeight(42, 10).height, 80 + LIFT, 'A, the last insertion');
  assert.equal(height.requestHeight(42, 10.0001).height, 80 + LIFT, 'C borrows A in the spent window');
  nextWindow();
  world.surface = () => 5;
  height.requestHeight(50, 50); // B in another cell: one eviction
  const before = reads.length;
  assert.equal(height.requestHeight(42, 10).height, 80 + LIFT, 'A survives as an exact hit');
  assert.equal(height.requestHeight(42, 10.0001).height, 80 + LIFT, 'C still borrows from A\'s surviving cell');
  assert.equal(reads.length, before);
});

test('a point left waiting outside a pass brings one pass back', (t) => {
  const { height, state, clock, world } = terrain(t, { surface: () => 10 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  addEntry(state, 'bus', { lat: 42.36, lon: -71.06 });
  height.anchorFloors();
  for (let i = 0; i < FLOOR_REREAD_ATTEMPTS; i++) {
    clock.now += FLOOR_REREAD_MS;
    t.mock.timers.tick(FLOOR_REREAD_MS);
  }
  assert.equal(state._floorTimer, null, 'the poll cycle has ended');
  // A visibility sweep spends the window on one path point before the next.
  clock.now += 5_000;
  world.costMs = TERRAIN_READ_BUDGET_MS;
  height.requestHeight(42.4, -71.1);
  const vertex = height.requestHeight(42.41, -71.11);
  assert.equal(vertex.height, null, 'the corridor vertex is deferred');
  const retry = state._floorTimer;
  assert.notEqual(retry, null, 'the deferred vertex schedules a retry');
  height.requestHeight(42.41, -71.11);
  assert.equal(state._floorTimer, retry);
  clock.now += FLOOR_REREAD_MS;
  t.mock.timers.tick(FLOOR_REREAD_MS);
  assert.equal(state._floorTimer, null, 'one extra pass ran');
});

test('a borrowed height keeps the cycle going until the point is read', (t) => {
  const { height, state, parts, reads, clock, world } = terrain(t, {
    surface: (lat, lon) => (lon > -71.05965 ? 40 : 10),
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const marker = { lat: 42.36, lon: -71.06 };
  // Settle the marker's height (read again after the settle time).
  height.requestHeight(marker.lat, marker.lon, null, TERRAIN_NEED.MARKER);
  clock.now += TERRAIN_SETTLE_MS + 1;
  height.requestHeight(marker.lat, marker.lon, null, TERRAIN_NEED.MARKER);
  // Nine path points in the marker's 0.001° cell, the last on a 40 m rise.
  const path = Array.from({ length: 9 }, (_, k) => ({ lat: 42.36, lon: -71.06 + (k + 1) * 0.00004 }));
  addEntry(state, 'bus', marker);
  let lastAnswer;
  parts.trails.prepareEntry = (e, collect) => {
    for (const point of path) {
      const answer = height.requestHeight(point.lat, point.lon, e);
      if (collect) collect(point, answer);
      lastAnswer = answer.height;
    }
  };
  world.costMs = 16; // one exact read per 200 ms window
  reads.length = 0;
  clock.now += TERRAIN_READ_WINDOW_MS;
  height.anchorFloors();
  let passes = 1;
  while (state._floorTimer && passes < 100) {
    clock.now += FLOOR_REREAD_MS;
    t.mock.timers.tick(FLOOR_REREAD_MS);
    passes++;
  }
  assert.equal(
    lastAnswer,
    40 + LIFT,
    `${passes} passes, ${reads.length} exact reads of 9 points; the last point answered ${lastAnswer} when the cycle stopped`,
  );
});

test('a camera turning in place reads settled heights again', (t) => {
  const { height, globe, reads, clock, world } = terrain(t, { surface: () => 10 });
  globe.camera = { lon: -71.06, lat: 42.36, height: 500, heading: 0, pitch: -0.5, roll: 0 };
  const read = () => height.requestHeight(42.3601, -71.0601, null, TERRAIN_NEED.MARKER).height;
  assert.equal(read(), 10 + LIFT);
  clock.now += TERRAIN_SETTLE_MS + 1;
  assert.equal(read(), 10 + LIFT, 're-read once settled');
  const settledReads = reads.length;
  // Free look: same position, new heading; a finer tile loads and is done
  // before Transit's next request, so every sample sees settled terrain.
  globe.camera = { ...globe.camera, heading: 1.2 };
  world.surface = () => 40;
  // Fifteen-second polls for two minutes.
  const answers = [];
  for (let poll = 0; poll < 8; poll++) {
    clock.now += 15_000;
    answers.push(read());
  }
  assert.equal(
    answers.at(-1),
    40 + LIFT,
    `answers over 2 min of polls: ${answers.join(',')}; terrain reads after the turn: ${reads.length - settledReads}`,
  );
});

test('undrawn history larger than the cache does not keep the cycle going', (t) => {
  const { height, state, parts, world, clock } = terrain(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const counts = new Map();
  world.onRead = (lat, lon) => {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  const marker = { lat: 10, lon: 10 };
  height.requestHeight(marker.lat, marker.lon, null, TERRAIN_NEED.MARKER);
  clock.now += TERRAIN_SETTLE_MS * 2;
  // 1,500 visible vehicles x 50 undrawn history fixes = 75,000 points, one per
  // floor cell, over the 60,000-point cache.
  const vehicles = 1500, per = 50;
  for (let v = 0; v < vehicles; v++) {
    const entry = addEntry(state, `v${v}`, marker);
    entry.history = Array.from({ length: per }, (_, i) => ({
      lat: 20 + Math.floor((v * per + i) / 300) * 0.002,
      lon: 20 + ((v * per + i) % 300) * 0.002,
    }));
  }
  parts.trails.prepareEntry = (entry, collect) => {
    for (const p of entry.history) {
      const answer = height.requestHeight(p.lat, p.lon, entry, TERRAIN_NEED.HISTORY);
      if (collect) collect(p, answer);
    }
  };
  world.cost = () => 0.0004; // about 10,000 history reads per pass
  height.anchorFloors();
  let passes = 1;
  while (state._floorTimer && passes < 32) {
    clock.now += FLOOR_REREAD_MS;
    t.mock.timers.tick(FLOOR_REREAD_MS);
    passes++;
  }
  assert.equal(passes, FLOOR_REREAD_ATTEMPTS + 1);
  const repeated = [...counts.values()].filter((c) => c > 1).length;
  assert.equal(state._floorTimer, null, `still armed after ${passes} passes; ${repeated} points read more than once after eviction`);
});

test('a point left for a later window is not warmed from the DEM', (t) => {
  const { height, state, parts, world, reads, warmed, nextWindow } = terrain(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const newest = { lat: 42.5, lon: -71.5 };
  addEntry(state, 'bus', newest);
  height.requestHeight(newest.lat, newest.lon, null, TERRAIN_NEED.MARKER);
  nextWindow();
  const A = { lat: 42.1, lon: -71.1 }; // local miss, 1 ms
  const B = { lat: 42.2, lon: -71.2 }; // success, 15 ms
  const C = { lat: 42.3, lon: -71.3 }; // loaded terrain, 40 m, deferred by the budget
  world.cost = (lat) => (lat === A.lat ? 1 : lat === B.lat ? 15 : 0);
  world.surface = (lat) => (lat === A.lat ? undefined : lat === B.lat ? 20 : 40);
  reads.length = 0;
  parts.trails.prepareEntry = (entry, collect) => {
    for (const p of [A, B, C]) {
      const answer = height.requestHeight(p.lat, p.lon, entry);
      if (collect) collect(p, answer);
    }
  };
  height.anchorFloors();
  assert.ok(!reads.includes(`${C.lat.toFixed(5)},${C.lon.toFixed(5)}`), 'C was deferred by the budget, not read');
  assert.ok(warmed.includes('42.1,-71.1'), 'the genuine miss is warmed');
  assert.ok(!warmed.includes('42.3,-71.3'), `a deferred, unread cell must not go to network DEM warming: ${warmed}`);
  nextWindow();
  assert.equal(height.requestHeight(C.lat, C.lon).height, 40 + LIFT);
});

test('a point borrows from the cell its answer names', (t) => {
  const { height, reads } = terrain(t, {
    costMs: 8,
    surface: (lat, lon) => (lon < -71.0625 ? 90 : 10),
  });
  assert.equal(height.requestHeight(42, -71.0628).height, 90 + LIFT);
  assert.equal(height.requestHeight(42, -71.0622).height, 10 + LIFT);
  assert.equal(reads.length, 2);
  const answer = height.requestHeight(42, -71.0625);
  assert.equal(reads.length, 2, 'the window is spent: the point borrows');
  assert.equal(answer.cell, '42,-71.063');
  assert.equal(answer.height, 90 + LIFT, `cell ${answer.cell} answered ${answer.height}`);
});
