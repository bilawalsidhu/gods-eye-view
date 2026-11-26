import assert from 'node:assert/strict';
import test from 'node:test';
import { groupStations } from './groups.js';

test('every station is in exactly one group', () => {
  const groups = groupStations(
    [
      { id: 'A', lat: 0.8, lon: 0.9, value: 10 },
      { id: 'B', lat: 0.8, lon: 1.6, value: 10 },
      { id: 'C', lat: 1.1, lon: 1.65, value: 10 },
    ],
    1,
  );
  const ids = groups.flatMap((group) =>
    group.members.map((member) => member.id),
  );
  assert.deepEqual(ids.sort(), ['A', 'B', 'C']);
});
