import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavaraGround } from './index.js';

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
