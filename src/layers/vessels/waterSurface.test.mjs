import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaterSurface, inlandWaterLevelM } from './waterSurface.js';
import { INLAND_WATER_MIN_ELEVATION_M } from './policy.js';

/**
 * A terrain cache over `elevationAt(lat, lon)` (the service's height above
 * sea level, or null where it has none), filled only by
 * resolveEllipsoidalGround as the application's is. Ellipsoidal height is the
 * elevation plus `geoidN`; `orthometric: false` leaves the service's
 * elevation out, as a service that sends none.
 */
function fakeGround(
  elevationAt,
  { geoidN = 0, fail = false, orthometric = true } = {},
) {
  const cache = new Map();
  const requested = [];
  const signals = [];
  let release = null;
  const ground = {
    cachedRealEllipsoidalGround: (lat, lon) =>
      cache.has(`${lat},${lon}`) ? cache.get(`${lat},${lon}`) + geoidN : null,
    async resolveEllipsoidalGround(cells, { signal } = {}) {
      requested.push(cells.map((c) => `${c.lat},${c.lon}`));
      signals.push(signal);
      if (ground.hold) await new Promise((resolve) => (release = resolve));
      if (fail) throw new Error('terrain unavailable');
      if (signal?.aborted) return;
      for (const c of cells) {
        const h = elevationAt(c.lat, c.lon);
        if (h != null) cache.set(`${c.lat},${c.lon}`, h);
      }
    },
    /** Another layer fetched this cell into the shared cache. */
    fill: (lat, lon, h) => cache.set(`${lat},${lon}`, h),
    release: () => release?.(),
    hold: false,
    requested,
    signals,
  };
  if (orthometric)
    ground.cachedRealOrthometricGround = (lat, lon) =>
      cache.has(`${lat},${lon}`) ? cache.get(`${lat},${lon}`) : null;
  return ground;
}

/** Let queued batches run. */
async function settle() {
  for (let i = 0; i < 10; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const cell = (elevation, geoidN = 0) => ({
  elevation,
  ellipsoid: elevation + geoidN,
});
const cells = (elevations, geoidN = 0) =>
  elevations.map((e) => cell(e, geoidN));

test('the sea, and terrain noise along its coasts, keep the geoid', () => {
  // Rotterdam harbour reads 0 to 4 m; Westerschelde 3.9 m.
  assert.equal(inlandWaterLevelM(cell(0.1), cells([0, 4, 3.9])), null);
  assert.equal(inlandWaterLevelM(cell(3.9), cells([3.9, 4])), null);
});

test('a lake or river is the lowest level another cell confirms', () => {
  // Lake Michigan: 176.8 m above sea level, ellipsoid 140.4 m.
  assert.equal(
    inlandWaterLevelM(cell(176.8, -36.4), cells([176.8, 177, 176.9], -36.4)),
    176.8 - 36.4,
  );
  // The Neckar: one low cell (a lock) is not the river on its own.
  assert.equal(
    inlandWaterLevelM(
      cell(162.4),
      cells([161.8, 162.2, 162.9, 162.3, 162.3, 161.7, 161.8, 156.9]),
    ),
    161.7,
  );
  // The Seattle ship canal, all cells at 5.0 m behind its locks.
  assert.equal(inlandWaterLevelM(cell(5), cells([5, 5, 5, 7])), 5);
  // At the threshold it is inland water; a level no cell confirms is not.
  const t = INLAND_WATER_MIN_ELEVATION_M;
  assert.equal(inlandWaterLevelM(cell(t), cells([t + 0.5])), t);
  assert.equal(inlandWaterLevelM(cell(8), cells([20, 40, 60])), null);
});

test('a vessel whose own cell is below sea level never takes the shore above', () => {
  // The Caspian's edge: the shore cells agree, the water cell is alone.
  assert.equal(inlandWaterLevelM(cell(-28), cells([-26, 6, 6.5, 7])), null);
});

test('water below sea level needs the vessel cell and three cells to agree', () => {
  // The Caspian.
  assert.equal(inlandWaterLevelM(cell(-28), cells([-28, -28, -28])), -28);
  // A hole in Antwerp's dock data: two deep cells, the rest at the quays.
  assert.equal(
    inlandWaterLevelM(
      cell(-12.2),
      cells([-12.1, -10, -9.8, -6.7, 5.5, 5.5, 5.8, 6]),
    ),
    null,
  );
  // A polder beside a port does not pull a sea vessel down.
  assert.equal(inlandWaterLevelM(cell(0.2), cells([-6, -6, -6])), null);
  // Nothing lower than the Dead Sea: sea-floor depths are not water.
  assert.equal(inlandWaterLevelM(cell(-432), cells([-432, -432])), -432);
  assert.equal(inlandWaterLevelM(cell(-2000), cells([-2000, -2000])), null);
});

test('an unknown cell gives no level', () => {
  assert.equal(inlandWaterLevelM(null, cells([140])), null);
  assert.equal(inlandWaterLevelM({ ellipsoid: 1 }, cells([140])), null);
});

test('a vessel at sea costs one terrain cell', async () => {
  const ground = fakeGround(() => 0.4, { geoidN: 43.6 });
  const water = createWaterSurface({ ground, geoidAt: () => 43.6 });
  assert.equal(water.levelAt(51.96, 4.01), undefined, 'not known yet');
  water.warm([{ lat: 51.96, lon: 4.01 }]);
  await settle();
  assert.deepEqual(ground.requested, [['51.96,4.01']]);
  assert.equal(water.levelAt(51.96, 4.01), null, 'the sea');
});

test('a vessel on a lake moves onto its level once the cells around arrive', async () => {
  const ground = fakeGround(() => 176.8, { geoidN: -36.4 });
  const warmed = [];
  const water = createWaterSurface({
    ground,
    geoidAt: () => -36.4,
    onWarm: (keys) => warmed.push(keys),
  });
  water.warm([{ lat: 44, lon: -87 }]);
  await settle();
  // Its own cell first, then the eight around it.
  assert.equal(ground.requested.length, 2);
  assert.deepEqual(ground.requested[0], ['44,-87']);
  assert.equal(ground.requested[1].length, 8);
  assert.ok(ground.requested[1].includes('44.001,-86.999'));
  assert.ok(Math.abs(water.levelAt(44, -87) - 140.4) < 1e-9);
  assert.ok(warmed.at(-1).has(water.cellKeyAt(44, -87)));
  // Known cells are not asked for again.
  water.warm([{ lat: 44, lon: -87 }]);
  await settle();
  assert.equal(ground.requested.length, 2);
});

test('without the service elevation, the bundled geoid stands in', async () => {
  const ground = fakeGround(() => 176.8, { geoidN: -36.4, orthometric: false });
  const water = createWaterSurface({ ground, geoidAt: () => -36.4 });
  water.warm([{ lat: 44, lon: -87 }]);
  await settle();
  assert.ok(Math.abs(water.levelAt(44, -87) - 140.4) < 1e-9);
});

test('a cell on its way is not asked for again', async () => {
  const ground = fakeGround(() => 0);
  ground.hold = true;
  const water = createWaterSurface({ ground, geoidAt: () => 0 });
  water.warm([{ lat: 10, lon: 10 }]);
  await settle();
  // Asked again (the next poll) while the first batch runs.
  water.warm([{ lat: 10, lon: 10 }]);
  ground.hold = false;
  ground.release();
  await settle();
  assert.deepEqual(ground.requested, [['10,10']]);
});

test('cancelling aborts the batch, drops the rest and moves nothing', async () => {
  const ground = fakeGround(() => 100);
  ground.hold = true;
  const warmed = [];
  const water = createWaterSurface({
    ground,
    geoidAt: () => 0,
    cellsPerBatch: 1,
    onWarm: (keys) => warmed.push(keys),
  });
  water.warm([
    { lat: 10, lon: 10 },
    { lat: 20, lon: 20 },
  ]);
  await settle();
  water.cancel();
  assert.equal(ground.signals[0].aborted, true);
  ground.hold = false;
  ground.release();
  await settle();
  assert.equal(warmed.length, 0);
  assert.equal(ground.requested.length, 1, 'the rest was dropped');
  // On again: it fetches as before.
  water.warm([{ lat: 30, lon: 30 }]);
  await settle();
  assert.deepEqual(ground.requested[1], ['30,30']);
  assert.ok(warmed.length >= 1);
});

test('the trail goes first, and a dropped list stops', async () => {
  const ground = fakeGround(() => 0);
  const water = createWaterSurface({
    ground,
    geoidAt: () => 0,
    cellsPerBatch: 1,
  });
  water.warm([
    { lat: 10, lon: 10 },
    { lat: 20, lon: 20 },
    { lat: 30, lon: 30 },
  ]);
  // Asked while the view's first batch runs: ahead of the view's rest.
  water.warm([{ lat: 40, lon: 40 }], { list: 'trail' });
  water.drop('view');
  await settle();
  assert.deepEqual(ground.requested, [['10,10'], ['40,40']]);
});

test('a failed batch or a throwing listener does not stop the next one', async () => {
  const failing = fakeGround(() => 0, { fail: true });
  const warmed = [];
  const water = createWaterSurface({
    ground: failing,
    geoidAt: () => 0,
    cellsPerBatch: 1,
    onWarm: (keys) => {
      warmed.push(keys);
      throw new Error('listener failed');
    },
  });
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    water.warm([
      { lat: 10, lon: 10 },
      { lat: 20, lon: 20 },
    ]);
    await settle();
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 2);
  assert.equal(failing.requested.length, 2);
  assert.equal(warmed.length, 2);
  assert.equal(water.levelAt(10, 10), undefined, 'still not known');
});

test('cells across the antimeridian wrap onto ±180°', async () => {
  const ground = fakeGround(() => 100);
  const water = createWaterSurface({ ground, geoidAt: () => 0 });
  water.warm([{ lat: 0, lon: 179.9999 }]);
  await settle();
  const lons = new Set(
    ground.requested.flat().map((key) => Number(key.split(',')[1])),
  );
  assert.ok(lons.has(-179.999));
  assert.ok([...lons].every((lon) => lon >= -180 && lon <= 180));
  assert.equal(water.levelAt(0, 179.9999), 100);
});

test('cells another layer fetched are read again at the next warm', async () => {
  const ground = fakeGround(() => 140);
  const water = createWaterSurface({ ground, geoidAt: () => 0 });
  // Something is known (a batch has landed) and this cell is not.
  water.warm([{ lat: 10, lon: 10 }]);
  await settle();
  assert.equal(water.levelAt(44, -87), undefined, 'remembered as unknown');
  for (let dLat = -1; dLat <= 1; dLat += 1)
    for (let dLon = -1; dLon <= 1; dLon += 1)
      ground.fill((44000 + dLat) / 1000, (-87000 + dLon) / 1000, 140);
  assert.equal(
    water.levelAt(44, -87),
    undefined,
    'still the remembered answer',
  );
  const asked = ground.requested.length;
  water.warm([{ lat: 44, lon: -87 }]);
  await settle();
  assert.equal(ground.requested.length, asked, 'nothing left to fetch');
  assert.equal(water.levelAt(44, -87), 140);
});

test('without terrain no level is ever known', async () => {
  const water = createWaterSurface({ ground: null, geoidAt: () => 0 });
  assert.equal(water.available, false);
  water.warm([{ lat: 44, lon: -87 }]);
  await settle();
  assert.equal(water.levelAt(44, -87), undefined);
  assert.equal(water.cellKeyAt(44, -87), null);
});

test('dropping a list stops its queued cells and the cells around them', async () => {
  const ground = fakeGround(() => 176.8);
  ground.hold = true;
  const water = createWaterSurface({
    ground,
    geoidAt: () => 0,
    cellsPerBatch: 1,
  });
  water.warm([
    { lat: 44, lon: -87 },
    { lat: 45, lon: -87 },
  ]);
  await settle();
  // The view moves on while its first cell is fetched.
  water.drop('view');
  ground.hold = false;
  ground.release();
  await settle();
  assert.deepEqual(ground.requested, [['44,-87']], 'no neighbours, no rest');
});

test('a list asks for no more cells than its budget', async () => {
  const ground = fakeGround(() => 176.8);
  const water = createWaterSurface({ ground, geoidAt: () => 0 });
  water.warm([{ lat: 44, lon: -87 }], { maxCells: 3 });
  await settle();
  assert.equal(ground.requested.flat().length, 3);
});

test('turned off and on during a batch, its cells are asked for again', async () => {
  const ground = fakeGround(() => 0);
  ground.hold = true;
  const water = createWaterSurface({ ground, geoidAt: () => 0 });
  water.warm([{ lat: 10, lon: 10 }]);
  await settle();
  water.cancel();
  water.warm([{ lat: 10, lon: 10 }]);
  ground.hold = false;
  ground.release();
  await settle();
  assert.deepEqual(ground.requested, [['10,10'], ['10,10']]);
  assert.equal(water.levelAt(10, 10), null);
});

test('the antimeridian is one cell, and own-cell reads need no neighbours', async () => {
  const ground = fakeGround((lat) => (lat > 43 ? 176.8 : 0.5));
  const water = createWaterSurface({ ground, geoidAt: () => 0 });
  assert.equal(water.cellKeyAt(0, 180), water.cellKeyAt(0, -180));
  water.warm(
    [
      { lat: 44, lon: -87 },
      { lat: 40, lon: -87 },
    ],
    { around: false },
  );
  await settle();
  assert.deepEqual(ground.requested, [['44,-87', '40,-87']]);
  assert.equal(water.levelAt(44, -87), undefined, 'unconfirmed');
  assert.equal(water.ownLevelAt(44, -87), 176.8);
  assert.equal(water.ownLevelAt(40, -87), null, 'the sea');
  assert.equal(water.ownLevelAt(30, -87), undefined, 'not fetched');
});

test('no more cells a minute than the budget, the rest when it frees up', async () => {
  const ground = fakeGround(() => 0);
  let now = 0;
  const timers = [];
  const clock = {
    now: () => now,
    setTimeout: (callback, ms) => timers.push({ callback, at: now + ms }),
    clearTimeout: () => {},
  };
  const water = createWaterSurface({
    ground,
    geoidAt: () => 0,
    cellsPerBatch: 1,
    cellsPerMinute: 2,
    clock,
  });
  water.warm([
    { lat: 10, lon: 10 },
    { lat: 20, lon: 20 },
    { lat: 30, lon: 30 },
  ]);
  await settle();
  assert.deepEqual(ground.requested, [['10,10'], ['20,20']]);
  assert.equal(timers.length, 1, 'the third waits for the minute');
  now = timers[0].at;
  timers[0].callback();
  await settle();
  assert.deepEqual(ground.requested.at(-1), ['30,30']);
});

test('trail cells go ahead of view cells already queued', async () => {
  const ground = fakeGround(() => 0);
  ground.hold = true;
  const water = createWaterSurface({
    ground,
    geoidAt: () => 0,
    cellsPerBatch: 1,
  });
  water.warm([
    { lat: 10, lon: 10 },
    { lat: 20, lon: 20 },
  ]);
  await settle();
  water.warm([{ lat: 40, lon: 40 }], { list: 'trail' });
  ground.hold = false;
  ground.release();
  await settle();
  assert.deepEqual(ground.requested, [['10,10'], ['40,40'], ['20,20']]);
});

test('a cell the service did not answer rests a minute, uncharged', async () => {
  let now = 0;
  const clock = {
    now: () => now,
    setTimeout: () => {},
    clearTimeout: () => {},
  };
  // The service answers nothing for this cell.
  const ground = fakeGround(() => null);
  const water = createWaterSurface({ ground, geoidAt: () => 0, clock });
  water.warm([{ lat: 10, lon: 10 }], { maxCells: 1 });
  await settle();
  // The next poll: not asked again, and the budget goes to the other point.
  water.warm(
    [
      { lat: 10, lon: 10 },
      { lat: 20, lon: 20 },
    ],
    { maxCells: 1 },
  );
  await settle();
  assert.deepEqual(ground.requested, [['10,10'], ['20,20']]);
  now = 61_000;
  water.warm([{ lat: 10, lon: 10 }]);
  await settle();
  assert.deepEqual(ground.requested.at(-1), ['10,10'], 'asked again later');
});

test('the trail is queued even when view cells fill a batch', async () => {
  const ground = fakeGround(() => 0);
  ground.hold = true;
  const water = createWaterSurface({
    ground,
    geoidAt: () => 0,
    cellsPerBatch: 2,
  });
  // The first batch runs; two more view cells wait, filling a batch.
  water.warm([
    { lat: 10, lon: 10 },
    { lat: 11, lon: 11 },
    { lat: 20, lon: 20 },
    { lat: 21, lon: 21 },
  ]);
  await settle();
  water.warm([{ lat: 40, lon: 40 }], { list: 'trail' });
  ground.hold = false;
  ground.release();
  await settle();
  assert.deepEqual(ground.requested[1][0], '40,40', 'the trail goes next');
});

test('a batch of an earlier ask queues nothing for the next one', async () => {
  const ground = fakeGround(() => 176.8);
  ground.hold = true;
  const water = createWaterSurface({ ground, geoidAt: () => 0 });
  water.warm([{ lat: 44, lon: -87 }]);
  await settle();
  // The view moves on while the lake cell is fetched.
  water.warm([{ lat: 10, lon: 10 }]);
  ground.hold = false;
  ground.release();
  await settle();
  const asked = ground.requested.flat();
  assert.ok(!asked.includes('44.001,-87'), 'no neighbours of the old view');
});

test('with no budget nothing is fetched, and nothing throws', async () => {
  const ground = fakeGround(() => 0);
  const water = createWaterSurface({
    ground,
    geoidAt: () => 0,
    cellsPerMinute: 0,
  });
  water.warm([{ lat: 10, lon: 10 }]);
  await settle();
  assert.deepEqual(ground.requested, []);
});
