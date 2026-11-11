import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoverStore, normalizeMoverSetOptions } from '../movers.js';
import { normalizeLineOptions } from '../lines.js';
import { createNavaraPicking } from './picking.js';
import { distanceToSegment } from '../cpuPicks.js';

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
});

test('a thin line is picked within 8 px of its segments', () => {
  const line = {
    options: normalizeLineOptions({
      id: 'trail',
      widthPx: 1,
      color: [1, 1, 1, 1],
      pickId: 'trail-1',
    }),
    flat: new Float64Array([0, 50, 100, 200, 50, 100]),
    modelMatrix: null,
  };
  const picking = createNavaraPicking({
    view: fakeView(),
    projector,
    camera,
    movers: () => [],
    lines: () => [line],
    resolveBatch: () => null,
  });
  assert.equal(picking.pick({ x: 100, y: 57.5 })?.id, 'trail-1');
  assert.equal(picking.pick({ x: 100, y: 58.5 }), undefined);
});

test('the pick id is the one the instance had when Navara answered', async () => {
  const view = fakeView();
  const sets = [moverSet('flights', [[10, 10, 5, 'before']])];
  let time = 0;
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => sets,
    lines: () => [],
    resolveBatch: (batchId) =>
      batchId === 1
        ? { set: 'flights', instance: 0, pickId: sets[0].store.pickIds[0] }
        : null,
    now: () => time,
    ...timers(),
  });
  view.emit('featureClick', { batchId: 1 });
  // The layer reuses the instance before the engine's click arrives.
  sets[0].store.set(0, { pickId: 'after' });
  time += 1;
  assert.equal((await picking.clickPick({ x: 10, y: 10 })).id, 'before');
});

test('a stale GPU answer for a neighbour of the click never wins over the instance under it (20 gestures)', async () => {
  // The followed aircraft A sits at the centre; B is drawn 15 px from it.
  // Navara answers B's click with the previous gesture's pick (A): within
  // twice A's pick radius, but the instance under the click is B.
  const view = fakeView();
  const sets = [
    moverSet('flights', [
      [100, 100, 5, 'a'],
      [115, 100, 5, 'b'],
    ]),
  ];
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => sets,
    lines: () => [],
    resolveBatch: (batchId) =>
      batchId === 1
        ? { set: 'flights', instance: 0, pickId: 'a' }
        : { set: 'flights', instance: 1, pickId: 'b' },
    ...timers(),
  });
  for (let gesture = 0; gesture < 20; gesture++) {
    const onA = picking.clickPick({ x: 100, y: 100 });
    view.emit('featureClick', { batchId: 1 });
    assert.equal((await onA).id, 'a', `gesture ${gesture}: a`);
    const onB = picking.clickPick({ x: 115, y: 100 });
    view.emit('featureClick', { batchId: 1 }); // stale: A again
    assert.equal((await onB).id, 'b', `gesture ${gesture}: b, not the stale a`);
  }
});

function modelSet(id, rows, radiusPx) {
  const options = normalizeMoverSetOptions({
    id,
    kind: 'model',
    capacity: rows.length,
    pickable: true,
    model: { url: 'model.glb', minimumPixelSize: 24 },
  });
  const store = createMoverStore(options);
  rows.forEach(([x, y, z, pickId], index) =>
    store.set(index, { position: { x, y, z }, pickId }),
  );
  store.setCount(rows.length);
  return { options, store, pickRadiusPx: () => radiusPx };
}

test('CPU hits rank as drawn: always-on-top sets, then set order, then depth', () => {
  const ordered = (id, order, depthTest, z) => {
    const options = normalizeMoverSetOptions({
      id,
      kind: 'point',
      capacity: 1,
      pickable: true,
      order,
      depthTest,
      point: { sizePx: 20 },
    });
    const store = createMoverStore(options);
    store.set(0, { position: { x: 100, y: 100, z }, pickId: id });
    store.setCount(1);
    return { options, store };
  };
  const sets = [
    ordered('local-adsb', -1, 'always', 5), // nearest, drawn under flights
    ordered('fleet', 0, 'always', 50),
    ordered('tracked', 2, 'always', 500), // farthest, drawn on top
    ordered('depth-tested', 5, 'normal', 1), // nearest of all, depth-tested
  ];
  const picking = createNavaraPicking({
    view: fakeView(),
    projector,
    camera,
    movers: () => sets,
    lines: () => [],
    resolveBatch: () => null,
    ...timers(),
  });
  assert.deepEqual(
    picking.drillPick({ x: 100, y: 100 }).map(({ id }) => id),
    ['tracked', 'fleet', 'local-adsb', 'depth-tested'],
  );
});

test('a model hit is checked against its projected position within its drawn radius', async () => {
  const view = fakeView();
  // A model drawn 40 px across (radius 20) at (100, 100).
  const sets = [modelSet('models', [[100, 100, 50, 'jet']], 20)];
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => sets,
    lines: () => [],
    resolveBatch: () => ({ set: 'models', instance: 0, pickId: 'jet' }),
    ...timers(),
  });
  // Within its radius (+3 px): the GPU answer stands.
  const inside = picking.clickPick({ x: 118, y: 100 });
  view.emit('featureClick', { batchId: 1 });
  assert.equal((await inside)?.id, 'jet');
  // A stale answer naming it from 60 px away: the CPU pick answers (nothing
  // drawn there).
  const outside = picking.clickPick({ x: 160, y: 100 });
  view.emit('featureClick', { batchId: 1 });
  assert.equal(await outside, undefined);
  // The CPU pick sees the model at its drawn radius, not the 24 px minimum.
  assert.equal(picking.drillPick({ x: 121, y: 100 })[0]?.id, 'jet');
  assert.equal(picking.drillPick({ x: 125, y: 100 }).length, 0);
});

test('stale GPU model hits cannot select hidden or removed instances', async () => {
  const view = fakeView();
  const model = modelSet('models', [[100, 100, 50, 'jet']], null);
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => [model],
    lines: () => [],
    resolveBatch: () => ({ set: 'models', instance: 0, pickId: 'jet' }),
    ...timers(),
  });
  model.store.set(0, { show: false });
  const hidden = picking.clickPick({ x: 100, y: 100 });
  view.emit('featureClick', { batchId: 1 });
  assert.equal(await hidden, undefined);
  model.store.setCount(0);
  const removed = picking.clickPick({ x: 100, y: 100 });
  view.emit('featureClick', { batchId: 1 });
  assert.equal(await removed, undefined);
  picking.destroy();
});

test('owned mesh triangle hits participate in hover, GPU-empty clicks and disposal', async () => {
  const view = fakeView();
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => [],
    lines: () => [],
    resolveBatch: () => null,
    ...timers(),
  });
  const hit = { id: 'plane', owner: 'plane' };
  const release = picking.registerMeshPicker((at) =>
    at.x === 10 ? [{ onTop: 0, order: 0, depth: 100, result: hit }] : [],
  );
  assert.equal(picking.pick({ x: 10, y: 20 }), hit);
  assert.equal(picking.pick({ x: 11, y: 20 }), undefined);
  const clicked = picking.clickPick({ x: 10, y: 20 });
  view.emit('featureClick', null);
  assert.equal(await clicked, hit);
  release();
  assert.equal(picking.pick({ x: 10, y: 20 }), undefined);
  picking.registerMeshPicker(() => [
    { onTop: 0, order: 0, depth: 100, result: hit },
  ]);
  picking.destroy();
  assert.equal(picking.pick({ x: 10, y: 20 }), undefined);
});

test('mesh picks preserve always-on-top siblings and reject stale sprite GPU answers', async () => {
  const view = fakeView();
  const sprite = moverSet('points', [[100, 100, 500, 'sprite']]);
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => [sprite],
    lines: () => [],
    resolveBatch: () => ({ set: 'points', instance: 0, pickId: 'sprite' }),
    ...timers(),
  });
  picking.registerMeshPicker(() => [
    { onTop: 0, order: 0, depth: 10, result: { id: 'plane', owner: 'plane' } },
  ]);
  const pending = picking.clickPick({ x: 100, y: 100 });
  view.emit('featureClick', { batchId: 1 });
  assert.equal((await pending).id, 'plane');
  sprite.options.depthTest = 'always';
  assert.equal(picking.pick({ x: 100, y: 100 }).id, 'sprite');
  picking.destroy();
});

test('an exact foreground mesh wins over a GPU model pick behind it', async () => {
  const view = fakeView();
  const model = modelSet('models', [[100, 100, 500, 'jet']], 20);
  const picking = createNavaraPicking({
    view,
    projector,
    camera,
    movers: () => [model],
    lines: () => [],
    resolveBatch: () => ({ set: 'models', instance: 0, pickId: 'jet' }),
    ...timers(),
  });
  const release = picking.registerMeshPicker(() => [
    {
      onTop: 0,
      order: 0,
      depth: 10,
      result: { id: 'plane', owner: 'plane' },
    },
  ]);
  const pending = picking.clickPick({ x: 100, y: 100 });
  view.emit('featureClick', { batchId: 1 });
  assert.equal((await pending).id, 'plane');
  release();
  const uncovered = picking.clickPick({ x: 100, y: 100 });
  view.emit('featureClick', { batchId: 1 });
  assert.equal((await uncovered).id, 'jet');
  picking.destroy();
});
