// The Context card for code outside the app's layers: open it on an item,
// close it, and hear the map selection change.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _connectContextCard,
  _mapSelectionChanged,
  closeContextCard,
  onMapSelectionChanged,
  openContextCard,
} from './contextCard.js';

function card() {
  const calls = [];
  return {
    calls,
    select: (item) => {
      calls.push(['select', item]);
      return item.id !== 'unknown';
    },
    clear: () => calls.push(['clear']),
  };
}

test('nothing opens before the app connects its card', () => {
  assert.equal(openContextCard({ layerId: 'cables', id: 'a' }), false);
  closeContextCard();
});

test('an item opens the connected card; closing closes it', () => {
  const connected = card();
  const off = _connectContextCard(connected);
  const item = { layerId: 'cables', id: 'cable:a', label: 'A' };
  assert.equal(openContextCard(item), true);
  assert.equal(openContextCard({ layerId: 'cables', id: 'unknown' }), false);
  closeContextCard();
  assert.deepEqual(connected.calls, [
    ['select', item],
    ['select', { layerId: 'cables', id: 'unknown' }],
    ['clear'],
  ]);
  off();
  assert.equal(openContextCard(item), false);
});

test('an item without a layer or an id opens nothing', () => {
  const connected = card();
  const off = _connectContextCard(connected);
  assert.equal(openContextCard(null), false);
  assert.equal(openContextCard({ id: 'a' }), false);
  assert.equal(openContextCard({ layerId: 'cables' }), false);
  assert.equal(openContextCard({ layerId: 'cables', id: '' }), false);
  assert.deepEqual(connected.calls, []);
  off();
});

test('a card that fails to open says so, and the caller carries on', () => {
  const off = _connectContextCard({
    select: () => {
      throw new Error('no record');
    },
    clear: () => {},
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(openContextCard({ layerId: 'cables', id: 'a' }), false);
  } finally {
    console.warn = warn;
    off();
  }
});

test('an id is given as words', () => {
  const connected = card();
  const off = _connectContextCard(connected);
  openContextCard({ layerId: 'satellites', id: 25544 });
  assert.deepEqual(connected.calls, [
    ['select', { layerId: 'satellites', id: '25544' }],
  ]);
  off();
});

test('a card connected later stays connected when an older one disconnects', () => {
  const first = card();
  const second = card();
  const offFirst = _connectContextCard(first);
  const offSecond = _connectContextCard(second);
  offFirst();
  assert.equal(openContextCard({ layerId: 'cables', id: 'a' }), true);
  assert.equal(second.calls.length, 1);
  offSecond();
});

test('the map selection is heard as layer and id', () => {
  const heard = [];
  const off = onMapSelectionChanged((selection, previous) =>
    heard.push([selection, previous]),
  );
  const a = { layerId: 'cables', id: 'cable:a', subject: { secret: true } };
  _mapSelectionChanged(a, null);
  _mapSelectionChanged(null, a);
  off();
  _mapSelectionChanged({ layerId: 'cables', id: 'cable:b' }, null);
  assert.deepEqual(heard, [
    [{ layerId: 'cables', id: 'cable:a' }, null],
    [null, { layerId: 'cables', id: 'cable:a' }],
  ]);
});
