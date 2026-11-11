import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from './testing/fakeEngine.js';
import {
  MOVER_KINDS,
  createMoverRegistry,
  createMoverSet,
  createMoverStore,
  normalizeMoverSetOptions,
} from './movers.js';

const atlas = {
  canvas: { width: 64, height: 32 },
  cells: { jet: [0, 0, 0.5, 1], heli: [0.5, 0, 1, 1] },
};

test('set options are normalised with the contract defaults', () => {
  assert.deepEqual(MOVER_KINDS, ['sprite', 'point', 'model']);
  const sprite = normalizeMoverSetOptions({
    id: 'flights',
    kind: 'sprite',
    capacity: 10,
    sprite: { atlas, sizePx: 24 },
  });
  assert.equal(sprite.id, 'flights');
  assert.equal(sprite.order, 0);
  assert.equal(sprite.retryAfterMs, 1500);
  assert.equal(sprite.depthTest, 'normal');
  assert.equal(sprite.pickable, false);
  assert.deepEqual(sprite.cellKeys, ['jet', 'heli']);
  assert.equal(sprite.sprite.scaleByDistance, null);
  const point = normalizeMoverSetOptions({
    id: 'sats',
    kind: 'point',
    capacity: 3,
    depthTest: { disableWithinM: 5000 },
    point: { sizePx: 4 },
  });
  assert.equal(point.point.outlinePx, 0);
  assert.deepEqual(point.depthTest, { disableWithinM: 5000 });
  const model = normalizeMoverSetOptions({
    id: 'models',
    kind: 'model',
    capacity: 2,
    model: { url: '/models/airplane.glb' },
  });
  assert.equal(model.model.minimumPixelSize, 0);
  assert.equal(model.model.colorBlend, null);
});

test('bad set options are refused with a TypeError', () => {
  for (const options of [
    {},
    { id: 'a', kind: 'cube', capacity: 1 },
    { id: 'a', kind: 'sprite', capacity: 0, sprite: { atlas, sizePx: 2 } },
    { id: 'a', kind: 'sprite', capacity: 1.5, sprite: { atlas, sizePx: 2 } },
    { id: 'a', kind: 'sprite', capacity: 1 },
    { id: 'a', kind: 'sprite', capacity: 1, sprite: { atlas, sizePx: -1 } },
    { id: 'a', kind: 'point', capacity: 1, point: {} },
    { id: 'a', kind: 'model', capacity: 1, model: {} },
    {
      id: 'a',
      kind: 'point',
      capacity: 1,
      point: { sizePx: 2 },
      depthTest: 'sometimes',
    },
    {
      id: 'a',
      kind: 'sprite',
      capacity: 1,
      sprite: { atlas, sizePx: 2, scaleByDistance: [1, 2] },
    },
  ])
    assert.throws(() => normalizeMoverSetOptions(options), TypeError);
});

test('the store keeps each instance in flat arrays with defaults', () => {
  const store = createMoverStore(
    normalizeMoverSetOptions({
      id: 'f',
      kind: 'sprite',
      capacity: 3,
      sprite: { atlas, sizePx: 16 },
    }),
  );
  assert.equal(store.capacity, 3);
  assert.equal(store.count, 0);
  store.set(1, {
    position: { x: 1, y: 2, z: 3 },
    rotation: 0.5,
    color: [1, 0, 0, 0.5],
    scale: 2,
    cell: 'heli',
    show: false,
    pickId: 'abc',
  });
  store.set(0, { position: { x: 4, y: 5, z: 6 } });
  assert.deepEqual([...store.positions.subarray(0, 6)], [4, 5, 6, 1, 2, 3]);
  assert.deepEqual(
    [...store.colors.subarray(0, 8)],
    [1, 1, 1, 1, 1, 0, 0, 0.5],
  );
  assert.equal(store.rotations[1], 0.5);
  assert.equal(store.scales[0], 1);
  assert.equal(store.scales[1], 2);
  assert.equal(store.cells[0], 0);
  assert.equal(store.cells[1], 1);
  assert.equal(store.shows[0], 1);
  assert.equal(store.shows[1], 0);
  assert.equal(store.pickIds[1], 'abc');
  assert.equal(store.pickIds[0], undefined);
  // set() without a field keeps the stored value.
  store.set(1, { position: { x: 7, y: 8, z: 9 } });
  assert.equal(store.scales[1], 2);
  assert.equal(store.shows[1], 0);
  store.setCount(2);
  assert.equal(store.count, 2);
  assert.deepEqual([...store.positionsView()], [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(store.dirty(), { from: 0, to: 2 });
  store.clean();
  assert.equal(store.dirty(), null);
  store.set(2, { position: { x: 0, y: 0, z: 1 } });
  assert.deepEqual(store.dirty(), { from: 2, to: 3 });
});

test('bad instances are refused and leave the store unchanged', () => {
  const store = createMoverStore(
    normalizeMoverSetOptions({
      id: 'f',
      kind: 'point',
      capacity: 2,
      point: { sizePx: 4 },
    }),
  );
  for (const [index, fields] of [
    [2, { position: { x: 0, y: 0, z: 0 } }],
    [-1, { position: { x: 0, y: 0, z: 0 } }],
    [0, { position: { x: Number.NaN, y: 0, z: 0 } }],
    [0, { color: [1, 1, 1] }],
    [0, { cell: 'jet' }],
    [0, { scale: -1 }],
  ])
    assert.throws(() => store.set(index, fields), TypeError);
  assert.throws(() => store.setCount(3), RangeError);
  assert.equal(store.dirty(), null);
});

test('models take an orientation quaternion', () => {
  const store = createMoverStore(
    normalizeMoverSetOptions({
      id: 'm',
      kind: 'model',
      capacity: 1,
      model: { url: '/m.glb' },
    }),
  );
  assert.deepEqual([...store.orientations], [0, 0, 0, 1]);
  store.set(0, { orientation: { x: 0, y: 0, z: 1, w: 0 } });
  assert.deepEqual([...store.orientations], [0, 0, 1, 0]);
  assert.throws(() => store.set(0, { orientation: { x: 0, y: 0 } }), TypeError);
});

test('the set facade forwards to the store and an engine commit, once destroyed it refuses', () => {
  const store = createMoverStore(
    normalizeMoverSetOptions({
      id: 'f',
      kind: 'point',
      capacity: 2,
      point: { sizePx: 4 },
    }),
  );
  const calls = [];
  const set = createMoverSet(store, {
    commit: () => calls.push(['commit', { ...store.dirty() }]),
    destroy: () => calls.push(['destroy']),
  });
  set.set(0, { position: { x: 1, y: 2, z: 3 } });
  set.setCount(1);
  assert.equal(set.count(), 1);
  assert.deepEqual([...store.positionsView()], [1, 2, 3]);
  set.commit();
  assert.deepEqual(calls, [['commit', { from: 0, to: 1 }]]);
  assert.equal(store.dirty(), null, 'commit cleans the store');
  set.destroy();
  set.destroy();
  assert.deepEqual(calls.at(-1), ['destroy']);
  assert.equal(calls.length, 2);
  assert.throws(() => set.set(0, {}), /destroyed/);
  assert.throws(() => set.commit(), /destroyed/);
});

test('a destroyed set releases its instance arrays', () => {
  const store = createMoverStore(
    normalizeMoverSetOptions({
      id: 'r',
      kind: 'point',
      capacity: 1000,
      point: { sizePx: 2 },
    }),
  );
  const set = createMoverSet(store, { commit() {}, destroy() {} });
  set.set(0, { position: { x: 1, y: 2, z: 3 }, pickId: 'p' });
  set.setCount(1);
  set.destroy();
  assert.equal(store.count, 0);
  assert.equal(store.positions.length, 0);
  assert.equal(store.pickIds.length, 0);
  assert.equal(store.positionsView().length, 0);
  assert.equal(store.dirty(), null);
});

test('a set is ready() once what it draws has loaded, never once destroyed', () => {
  let loaded = false;
  const registry = createMoverRegistry(() => ({
    commit() {},
    destroy() {},
    ready: () => loaded,
  }));
  const set = registry.movers.createSet({
    id: 'r',
    kind: 'point',
    capacity: 1,
    point: { sizePx: 4 },
  });
  assert.equal(set.ready(), false);
  loaded = true;
  assert.equal(set.ready(), true);
  set.destroy();
  assert.equal(set.ready(), false);
  const plain = createMoverRegistry(() => ({ commit() {}, destroy() {} }));
  assert.equal(
    plain.movers
      .createSet({ id: 'p', kind: 'point', capacity: 1, point: { sizePx: 4 } })
      .ready(),
    true,
    'an engine part without ready() draws at once',
  );
});

test('point outline RGBA is validated and copied independently of the caller', () => {
  const color = [1, 0.5, 0, 0.3];
  const options = normalizeMoverSetOptions({
    id: 'outlined',
    kind: 'point',
    capacity: 1,
    point: { sizePx: 14, outlinePx: 2, outlineColor: color },
  });
  color[0] = 0;
  assert.deepEqual(options.point.outlineColor, [1, 0.5, 0, 0.3]);
  assert.ok(Object.isFrozen(options.point.outlineColor));
  for (const outlineColor of [
    [1, 0, 0],
    [1, 0, 0, 2],
    [NaN, 0, 0, 1],
  ])
    assert.throws(
      () =>
        normalizeMoverSetOptions({
          id: 'bad',
          kind: 'point',
          capacity: 1,
          point: { sizePx: 14, outlineColor },
        }),
      TypeError,
    );
});

test('native-stage sprite fields opt into sharpening explicitly and reject model misuse', () => {
  const base = {
    id: 'firms',
    kind: 'sprite',
    capacity: 1,
    sprite: { atlas, sizePx: 56 },
  };
  assert.equal(normalizeMoverSetOptions(base).sharpen, false);
  assert.equal(
    normalizeMoverSetOptions({ ...base, sharpen: true }).sharpen,
    true,
  );
  assert.throws(
    () => normalizeMoverSetOptions({ ...base, sharpen: 'true' }),
    TypeError,
  );
  assert.throws(
    () =>
      normalizeMoverSetOptions({
        id: 'm',
        kind: 'model',
        capacity: 1,
        model: { url: '/box.glb' },
        sharpen: true,
      }),
    TypeError,
  );
});

test('retry delay rejects invalid values and accepts zero', () => {
  const options = {
    id: 'retry',
    kind: 'model',
    capacity: 1,
    model: { url: '/a.glb' },
  };
  for (const retryAfterMs of [-1, NaN, Infinity, '1500'])
    assert.throws(
      () => normalizeMoverSetOptions({ ...options, retryAfterMs }),
      /retryAfterMs/,
    );
  assert.equal(
    normalizeMoverSetOptions({ ...options, retryAfterMs: 0 }).retryAfterMs,
    0,
  );
});

for (const kind of ['cesium', 'navara'])
  test(`${kind} fake models retry twice, keep failure until success and reset for a new identity`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const engine = createFakeEngine({ kind });
    t.after(() => engine.destroy());
    const attempts = [];
    engine.fake.script('moverFailed', (id, index, attempt) => {
      attempts.push(attempt);
      return attempt < 3;
    });
    const set = engine.movers.createSet({
      id: 'model',
      kind: 'model',
      capacity: 2,
      model: { url: '/a.glb' },
    });
    set.set(0, { pickId: 'a' });
    set.setCount(1);
    set.commit();
    assert.equal(set.failed(), true);
    assert.equal(set.failed(1), false);
    assert.equal(set.ready(1), false);
    t.mock.timers.tick(1499);
    assert.deepEqual(attempts, [1]);
    t.mock.timers.tick(1);
    assert.equal(set.failed(0), true);
    t.mock.timers.tick(1500);
    assert.equal(set.failed(), false);
    assert.equal(set.ready(0), true);
    assert.deepEqual(attempts, [1, 2, 3]);
    set.set(0, { pickId: 'b' });
    set.commit();
    assert.equal(set.failed(0), true);
    set.destroy();
    t.mock.timers.tick(10000);
    assert.deepEqual(attempts, [1, 2, 3, 1]);
    assert.equal(set.ready(), false);
    assert.equal(set.failed(), false);
  });

test('fake model permanent failure stops after three attempts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = createFakeEngine();
  t.after(() => engine.destroy());
  let attempts = 0;
  engine.fake.script('moverFailed', () => {
    attempts++;
    return true;
  });
  const set = engine.movers.createSet({
    id: 'model',
    kind: 'model',
    capacity: 1,
    retryAfterMs: 10,
    model: { url: '/a.glb' },
  });
  set.setCount(1);
  set.commit();
  t.mock.timers.tick(10);
  t.mock.timers.tick(10);
  t.mock.timers.tick(1000);
  assert.equal(attempts, 3);
  assert.equal(set.failed(), true);
  assert.equal(set.ready(), false);
});
