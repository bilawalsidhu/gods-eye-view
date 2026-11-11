import assert from 'node:assert/strict';
import test from 'node:test';
import { createPickIndex } from './pickIds.js';

test('a batch id resolves to its set, instance and pick id', () => {
  const index = createPickIndex();
  const pickIds = ['a', 'b', 'c'];
  index.add('flights', { batchIds: [11, 12, 13] }, (i) => pickIds[i]);
  index.add('sats', { batchIds: [21] }, () => 99);
  assert.deepEqual(index.resolve(12), {
    set: 'flights',
    instance: 1,
    pickId: 'b',
  });
  assert.deepEqual(index.resolve(21), { set: 'sats', instance: 0, pickId: 99 });
  assert.equal(index.resolve(5), null);
  index.remove('flights');
  assert.equal(index.resolve(12), null);
});
