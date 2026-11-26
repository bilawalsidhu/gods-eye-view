import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createViewFrameRate,
  frameRateOf,
  UNLIMITED_STOP,
} from './viewFrameRate.js';

function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
  };
}

function fakeStore() {
  const shown = [];
  let owner = null;
  return {
    shown,
    publishFrameRate: (next) => shown.push(next),
    connect: (handlers) => ((owner = handlers), 'token'),
    detach: () => (owner = null),
    act: (name, ...args) => owner?.[name]?.(...args),
  };
}

test('60 until the user sets a rate; the slider runs 30 to 240, then unlimited', () => {
  const applied = [];
  const store = fakeStore();
  createViewFrameRate({
    store,
    storage: memoryStorage(),
    apply: (fps) => applied.push(fps),
  });
  assert.deepEqual(applied, [60]);
  assert.deepEqual(store.shown.at(-1), {
    fps: 60,
    stop: 60,
    min: 30,
    max: 250,
    step: 10,
  });
  assert.equal(UNLIMITED_STOP, 250);
});

test("the user's rate is applied, kept across visits, and its last stop is unlimited", () => {
  const storage = memoryStorage();
  const applied = [];
  const store = fakeStore();
  const view = createViewFrameRate({
    store,
    storage,
    apply: (fps) => applied.push(fps),
  });
  store.act('setFrameRate', 144);
  assert.equal(applied.at(-1), 144);
  assert.equal(store.shown.at(-1).fps, 144);
  store.act('setFrameRate', UNLIMITED_STOP);
  assert.equal(applied.at(-1), 0, 'unlimited');
  assert.deepEqual(store.shown.at(-1), {
    fps: 0,
    stop: 250,
    min: 30,
    max: 250,
    step: 10,
  });
  view.destroy();
  assert.equal(store.shown.at(-1), null);

  const again = [];
  createViewFrameRate({
    store: fakeStore(),
    storage,
    apply: (fps) => again.push(fps),
  });
  assert.deepEqual(again, [0], 'unlimited, as left');
});

test('a saved rate out of range or not a number is read as the nearest it can be, or 60', () => {
  const read = (saved) => {
    const applied = [];
    createViewFrameRate({
      store: fakeStore(),
      storage: memoryStorage({ 'godsEyeView.frameRate': saved }),
      apply: (fps) => applied.push(fps),
    });
    return applied[0];
  };
  assert.equal(read('10'), 30);
  assert.equal(read('120'), 120);
  assert.equal(read('0'), 0);
  assert.equal(read('999'), 0);
  assert.equal(read('fast'), 60);
  assert.equal(frameRateOf(59.6), 60);
  assert.equal(frameRateOf(undefined), null);
});
