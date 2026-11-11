import test from 'node:test';
import assert from 'node:assert/strict';
import { vesselPositionAt } from './motion.js';

const record = {
  lat: 1,
  lon: 1,
  motion: {
    fromLat: 0,
    fromLon: 0,
    fromMs: 1_000,
    toLat: 1,
    toLon: 1,
    toMs: 3_000,
  },
};

test('a vessel holds at its fixes and moves between them along the great circle', () => {
  assert.deepEqual(vesselPositionAt(record, 500), { lat: 0, lon: 0 });
  assert.equal(vesselPositionAt(record, 3_000), record);
  assert.equal(vesselPositionAt(record, 9_000), record, 'never projected past');
  const half = vesselPositionAt(record, 2_000);
  assert.ok(Math.abs(half.lat - 0.5) < 1e-3);
  assert.ok(Math.abs(half.lon - 0.5) < 1e-3);
});

test('a vessel with no move is at its record', () => {
  const still = { lat: 4, lon: 5 };
  assert.equal(vesselPositionAt(still, 2_000), still);
  assert.equal(vesselPositionAt({ ...still, motion: null }, 2_000).lat, 4);
});
