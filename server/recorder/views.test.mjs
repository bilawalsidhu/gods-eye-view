import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanView, readViews, roomForView, viewName } from './views.js';
import { openHistoryStore } from './store.js';

const box = { west: -5, south: 50, east: 2, north: 55 };

test('a view name is tidied and limited', () => {
  assert.equal(viewName('  North   Sea \n'), 'North Sea');
  assert.throws(() => viewName('   '), /name/);
  assert.throws(() => viewName('x'.repeat(61)), /at most/);
});

test('a view keeps what can be replayed and drops the rest', () => {
  const view = cleanView({
    fromSec: 1700000000,
    windowHours: 24,
    layers: ['air', 'boat', 'sat'],
    region: box,
    speed: 60,
    extra: 'ignored',
  });
  assert.deepEqual(view, {
    fromSec: 1700000000,
    windowHours: 24,
    layers: ['air', 'sat'],
    region: box,
    speed: 60,
  });
  const plain = cleanView({ layers: ['air'], windowHours: 5, speed: 7 });
  assert.deepEqual(plain, { fromSec: null, windowHours: 6, layers: ['air'], region: null, speed: 10 });
});

test('a view that could not be applied is refused', () => {
  assert.throws(() => cleanView({ layers: [] }), /layer/);
  assert.throws(() => cleanView({ layers: ['air'], region: { ...box, south: 60 } }), /area/);
  assert.throws(() => cleanView({ layers: ['air'], region: { ...box, west: 500 } }), /area/);
  assert.equal(roomForView(200, false), false);
  assert.equal(roomForView(200, true), true);
});

test('views are saved, replaced by name, listed and removed', () => {
  const store = openHistoryStore(':memory:');
  store.saveView('A', JSON.stringify(cleanView({ layers: ['air'] })), 100);
  store.saveView('B', JSON.stringify(cleanView({ layers: ['sat'], windowHours: 24 })), 101);
  store.saveView('A', JSON.stringify(cleanView({ layers: ['mil'] })), 200);
  store.saveView('bad', '{not json', 300);
  const list = readViews(store.listViews());
  assert.deepEqual(list.map((v) => v.name), ['A', 'B']);
  assert.deepEqual(list[0].view.layers, ['mil']);
  assert.equal(list[0].savedTs, 200);
  assert.equal(store.removeView('A'), 1);
  assert.equal(store.removeView('A'), 0);
  assert.deepEqual(readViews(store.listViews()).map((v) => v.name), ['B']);
  store.close();
});
