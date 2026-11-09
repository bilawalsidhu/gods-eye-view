import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createNavaraGround } from './index.js';

// The pass owns real data textures; the view below does not create GPU effects.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === '@navaramap/three'
      ? {
          url: 'data:text/javascript,export class EffectDesc {} export class Effect {}',
          shortCircuit: true,
        }
      : nextResolve(specifier, context);
  },
});
const { createGroundPass } = await import('./pass.js');
hooks.deregister();

function passView() {
  const effects = new Set();
  return Object.assign(fakeView(), {
    effects,
    registerEffect() {},
    addEffect(config) {
      const handle = {
        config,
        update(next) {
          Object.assign(config, next);
        },
        delete() {
          effects.delete(handle);
        },
      };
      effects.add(handle);
      return handle;
    },
  });
}

function fakeView({ height = () => 12 } = {}) {
  const listeners = new Map();
  return {
    frames: 0,
    on: (name, listener) => listeners.set(name, listener),
    off: (name) => listeners.delete(name),
    forceUpdate() {
      this.frames++;
    },
    sampleTerrainHeight: ({ lat, lng }) => height(lng, lat),
    postRender: () => listeners.get('postRender')?.(),
    listening: () => listeners.size,
  };
}

function fakePass() {
  const states = [];
  return {
    states,
    owner: { state: null },
    set(state) {
      states.push(state);
      this.owner.state = state;
    },
    textureBytes: () => 0,
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
}

const square = (lon) => ({
  rings: [
    [
      [lon, 0],
      [lon + 1, 0],
      [lon + 1, 1],
    ],
  ],
  fill: [1, 0, 0, 1],
});

test('shown sets compose in order into one pass; hiding all hides it', () => {
  const view = fakeView();
  const pass = fakePass();
  const ground = createNavaraGround(view, { createPass: () => pass });
  const top = ground.ground.createSet({ id: 'top', kind: 'polygon', order: 1 });
  const bottom = ground.ground.createSet({ id: 'bottom', kind: 'polygon' });
  top.replace([square(0)]);
  top.commit();
  bottom.replace([square(2), square(4)]);
  bottom.commit();
  const state = pass.states.at(-1);
  assert.equal(state.count, 3);
  assert.ok(view.frames >= 2, 'each change asks for a frame');
  top.show(false);
  bottom.show(false);
  assert.equal(pass.states.at(-1), null);
  bottom.show(true);
  assert.equal(pass.states.at(-1).count, 2);
  assert.equal(ground.pickables().length, 2);
  ground.destroy();
  assert.equal(pass.destroyed, true);
  assert.equal(view.listening(), 0);
});

test('a set packed before its terrain loaded is packed again later', () => {
  let loaded = false;
  const view = fakeView({ height: () => (loaded ? 30 : undefined) });
  const pass = fakePass();
  const ground = createNavaraGround(view, { createPass: () => pass });
  const set = ground.ground.createSet({ id: 'zones', kind: 'polygon' });
  set.replace([square(0)]);
  set.commit();
  const before = pass.states.length;
  for (let frame = 0; frame < 29; frame++) view.postRender();
  assert.equal(pass.states.length, before, 'not before 30 frames');
  loaded = true;
  view.postRender();
  assert.equal(pass.states.length, before + 1, 'packed again with heights');
  for (let frame = 0; frame < 500; frame++) view.postRender();
  assert.equal(pass.states.length, before + 1, 'no more once it has them');
  ground.destroy();
});

test('while a shown set pulses or dashes, every frame asks for the next', () => {
  const view = fakeView();
  const pass = fakePass();
  const queued = [];
  const ground = createNavaraGround(view, {
    createPass: () => pass,
    nextFrame: (run) => queued.push(run),
  });
  const set = ground.ground.createSet({ id: 'route', kind: 'corridor' });
  set.replace([
    {
      positions: [
        [0, 0],
        [0.1, 0],
      ],
      color: [0, 1, 1, 1],
      widthPx: 9,
      dash: { cells: 8, duty: 0.5, speed: 1 },
    },
  ]);
  set.commit();
  const before = view.frames;
  view.postRender();
  view.postRender();
  assert.equal(queued.length, 1, 'one request a display frame');
  queued.shift()();
  assert.equal(view.frames, before + 1);
  set.show(false);
  view.postRender();
  assert.equal(queued.length, 0, 'none while hidden');
  set.show(true);
  view.postRender();
  ground.destroy();
  const destroyed = view.frames;
  queued.shift()();
  assert.equal(view.frames, destroyed, 'none after destroy');
});

test('corridor reveal updates item data without repacking geometry, including hide and commit', () => {
  const pass = fakePass(),
    updates = [];
  pass.reveal = (...args) => updates.push(args);
  const port = createNavaraGround(fakeView(), { createPass: () => pass });
  const set = port.ground.createSet({
    id: 'head',
    kind: 'corridor',
    reveal: true,
  });
  const items = [
    {
      positions: [
        [20, 10],
        [20.001, 10],
      ],
      widthPx: 5,
      color: [0, 1, 0, 0.8],
    },
  ];
  set.replace(items);
  set.commit();
  const state = pass.owner.state;
  const count = pass.states.length;
  set.setReveal(0.25);
  set.setReveal(0.5);
  assert.equal(pass.states.length, count);
  assert.equal(pass.owner.state.segments, state.segments);
  assert.deepEqual(updates, [
    [0, 1, 0.25],
    [0, 1, 0.5],
  ]);
  set.show(false);
  set.setReveal(0.75);
  set.show(true);
  assert.equal(pass.owner.state.items.data[20], 0.75);
  set.replace(items);
  set.commit();
  assert.equal(pass.owner.state.items.data[20], 0.75);
  set.destroy();
  port.destroy();
});

test('destroying a revealed corridor leaves the next ground set with fresh pass data', () => {
  const corridor = {
    positions: [
      [20, 10],
      [20.1, 10],
    ],
    widthPx: 12,
    color: [1, 0, 1, 1],
  };
  const view = passView();
  const pass = createGroundPass(view);
  const port = createNavaraGround(view, { createPass: () => pass });
  const set = port.ground.createSet({
    id: 'reveal',
    kind: 'corridor',
    reveal: true,
  });
  set.replace([corridor]);
  set.commit();
  set.setReveal(0.25);
  assert.equal(pass.owner.state.items.data[20], 0.25);
  set.destroy();
  assert.equal(pass.owner.state, null);
  assert.equal(pass.owner.textures, null);
  assert.equal(
    view.effects.size,
    0,
    'no retired ground effect remains in the pulse insertion path',
  );

  for (const [kind, item] of [
    ['corridor', corridor],
    ['polygon', square(20)],
    ['disc', { center: [20, 10], radiusM: 500, fill: [0, 1, 0, 1] }],
    ['cell', { west: 20, east: 21, south: 10, north: 11, fill: [0, 0, 1, 1] }],
  ]) {
    const freshView = passView();
    const freshPass = createGroundPass(freshView);
    const fresh = createNavaraGround(freshView, {
      createPass: () => freshPass,
    });
    const next = port.ground.createSet({ id: 'next', kind });
    const expected = fresh.ground.createSet({ id: 'next', kind });
    for (const target of [next, expected]) {
      target.replace([item]);
      target.commit();
    }
    for (const key of [
      'styles',
      'segments',
      'bins',
      'runs',
      'items',
      'frames',
      'grid',
      'candidates',
    ])
      assert.deepEqual(
        pass.owner.state[key],
        freshPass.owner.state[key],
        `${kind}: ${key}`,
      );
    assert.throws(() => set.setReveal(0.9), /destroyed/);
    assert.deepEqual(pass.owner.state.items, freshPass.owner.state.items);
    next.destroy();
    fresh.destroy();
  }
  port.destroy();
});

test('ground sets carry their surface classification into the frame texture', async () => {
  const { matrix4 } = await import('../../../geo/index.js');
  const pass = fakePass();
  const port = createNavaraGround(fakeView(), { createPass: () => pass });
  for (const [drape, expected] of [
    ['terrain', 1],
    ['tiles', 2],
    ['both', 0],
  ]) {
    const set = port.ground.createSet({ id: drape, kind: 'polygon', drape });
    set.replace([square(0)]);
    set.commit();
    const state = pass.owner.state;
    state.update(matrix4.IDENTITY, matrix4.IDENTITY, 800, 600);
    assert.equal(state.frames.data[(state.count - 1) * 16 + 15], expected);
  }
  port.destroy();
});
