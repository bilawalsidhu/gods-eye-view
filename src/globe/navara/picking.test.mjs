import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoverStore, normalizeMoverSetOptions } from '../movers.js';
import { normalizeLineOptions } from '../lines.js';
import { createNavaraPicking, distanceToSegment } from './picking.js';

// A projector that maps x → screen x and y → screen y, z is the depth (the
// distance from the camera at the origin along +z).
const projector = {
  worldToWindow: (p) => ({ x: p.x, y: p.y }),
  horizonVisible: (p) => p.z > 0,
};
const camera = { livePosition: { x: 0, y: 0, z: 0 } };

function moverSet(id, rows, { pickable = true, sizePx = 20 } = {}) {
  const options = normalizeMoverSetOptions({
    id,
    kind: 'point',
    capacity: rows.length,
    pickable,
    point: { sizePx },
  });
  const store = createMoverStore(options);
  rows.forEach(([x, y, z, pickId], index) =>
    store.set(index, { position: { x, y, z }, pickId }),
  );
  store.setCount(rows.length);
  return { options, store };
}

function fakeView() {
  const handlers = new Map();
  return {
    on(name, fn) {
      handlers.set(name, fn);
    },
    off(name) {
      handlers.delete(name);
    },
    emit(name, value) {
      handlers.get(name)?.(value);
    },
    handlers,
  };
}

const timers = () => {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = pending.indexOf(timer);
      if (index >= 0) pending.splice(index, 1);
    },
  };
};

test('the distance from a point to a segment', () => {
  assert.equal(
    distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }),
    3,
  );
  assert.equal(
    distanceToSegment({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }),
    5,
  );
});

test('CPU picks: pickable sets and lines under a point, nearest first', () => {
  const sets = [
    moverSet('flights', [
      [100, 100, 500, 'far'],
      [104, 100, 50, 'near'],
      [300, 300, 10, 'elsewhere'],
    ]),
    moverSet('hidden', [[100, 100, -5, 'behind-the-globe']]),
    moverSet('quiet', [[100, 100, 20, 'not-pickable']], { pickable: false }),
  ];
  const line = {
    options: normalizeLineOptions({
      id: 'orbit',
      widthPx: 4,
      color: [1, 1, 1, 1],
      pickId: 'orbit-1',
    }),
    flat: new Float64Array([90, 103, 200, 110, 103, 200]),
    modelMatrix: null,
  };
  const picking = createNavaraPicking({
    view: fakeView(),
    projector,
    camera,
    movers: () => sets,
    lines: () => [line],
    resolveBatch: () => null,
  });
  const drilled = picking.drillPick({ x: 100, y: 100 }, 8);
  assert.deepEqual(
    drilled.map(({ id, owner }) => [id, owner]),
    [
      ['near', 'flights'],
      ['orbit-1', 'orbit'],
      ['far', 'flights'],
    ],
  );
  assert.equal(drilled[0].instance, 1);
  assert.deepEqual(picking.pick({ x: 100, y: 100 }).id, 'near');
  assert.equal(picking.pick({ x: 600, y: 600 }), undefined);
  assert.equal(picking.drillPick({ x: 100, y: 100 }, 1).length, 1);
});

test('a click takes the GPU pick of its gesture, a batch id resolved to the instance', async () => {
  const view = fakeView();
  const clock = timers();
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => [],
    lines: () => [],
    resolveBatch: (batchId) =>
      batchId === 42 ? { set: 'flights', instance: 3, pickId: 'ae01ce' } : null,
    ...clock,
  });
  const answer = picking.clickPick({ x: 1, y: 1 });
  view.emit('featureClick', { batchId: 42 });
  assert.deepEqual(await answer, {
    id: 'ae01ce',
    owner: 'flights',
    instance: 3,
  });
  assert.equal(clock.pending.length, 0, 'the timeout is cleared');
  // Empty space: Navara reports null; a CPU line pick could still answer.
  const empty = picking.clickPick({ x: 1, y: 1 });
  view.emit('featureClick', null);
  assert.equal(await empty, undefined);
});

test('without a GPU answer in time the click falls back to the CPU pick', async () => {
  const view = fakeView();
  const clock = timers();
  const sets = [moverSet('flights', [[10, 10, 5, 'cpu']])];
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => sets,
    lines: () => [],
    resolveBatch: () => null,
    ...clock,
  });
  const answer = picking.clickPick({ x: 10, y: 10 });
  assert.equal(clock.pending.length, 1);
  clock.pending[0].fn();
  assert.deepEqual(await answer, { id: 'cpu', owner: 'flights', instance: 0 });
  picking.destroy();
  assert.equal(view.handlers.size, 0);
});

test('click stats count GPU answers and timeouts with their latency', async () => {
  const view = fakeView();
  const clock = timers();
  let time = 0;
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => [],
    lines: () => [],
    resolveBatch: () => null,
    now: () => time,
    ...clock,
  });
  const first = picking.clickPick({ x: 0, y: 0 });
  time = 30;
  view.emit('featureClick', null);
  await first;
  const second = picking.clickPick({ x: 0, y: 0 });
  time = 280;
  clock.pending[0].fn();
  await second;
  assert.deepEqual(picking.clickStats(), {
    gpu: 1,
    timeout: 1,
    stale: 0,
    latencies: [30, 250],
  });
});

test("Navara's answer may come before the engine's click of the same gesture", async () => {
  const view = fakeView();
  const clock = timers();
  let time = 1000;
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => [],
    lines: () => [],
    resolveBatch: (batchId) =>
      batchId === 7 ? { set: 'sats', instance: 0, pickId: 25544 } : null,
    now: () => time,
    ...clock,
  });
  view.emit('featureClick', { batchId: 7 });
  time += 2;
  assert.deepEqual(await picking.clickPick({ x: 0, y: 0 }), {
    id: 25544,
    owner: 'sats',
    instance: 0,
  });
  assert.equal(clock.pending.length, 0);
  // A stale answer (a click no listener took) is not reused.
  view.emit('featureClick', { batchId: 7 });
  time += 500;
  const late = picking.clickPick({ x: 0, y: 0 });
  assert.equal(clock.pending.length, 1);
  view.emit('featureClick', null);
  assert.equal(await late, undefined);
});

test('a GPU answer naming an instance drawn far from the click is stale', async () => {
  const view = fakeView();
  const sets = [
    moverSet('flights', [
      [10, 10, 5, 'drawn-here'],
      [400, 400, 5, 'far-away'],
    ]),
  ];
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => sets,
    lines: () => [],
    resolveBatch: (batchId) =>
      batchId === 2
        ? { set: 'flights', instance: 1, pickId: 'far-away' }
        : null,
    ...timers(),
  });
  const answer = picking.clickPick({ x: 10, y: 10 });
  view.emit('featureClick', { batchId: 2 });
  assert.equal((await answer).id, 'drawn-here');
  assert.equal(picking.clickStats().stale, 1);
});
