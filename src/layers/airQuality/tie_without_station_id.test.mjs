import assert from 'node:assert/strict';
import test from 'node:test';
import { readingsInView } from './model.js';

test('equal readings without stationId are ordered by their id', () => {
  const rows = [
    { id: 'b', value: 50, lat: 0, lon: 0 },
    { id: 'a', value: 50, lat: 0, lon: 0 },
  ];
  assert.deepEqual(
    readingsInView(rows, null, 2)
      .map((row) => row.id)
      .sort(),
    ['a', 'b'],
  );
});
