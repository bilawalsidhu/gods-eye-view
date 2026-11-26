import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FIRE_FILTER, filterFires } from './index.js';

test('the fire layer exports the filter its markers use', () => {
  const fires = [
    { frp: 2, confidence: 0.3 },
    { frp: 40, confidence: 0.9 },
  ];
  assert.equal(filterFires(fires, DEFAULT_FIRE_FILTER), fires);
  assert.deepEqual(filterFires(fires, { minFrp: 10, confidence: 'all' }), [
    fires[1],
  ]);
});
