import test from 'node:test';
import assert from 'node:assert/strict';
import { fixesMove, vesselPositionAt } from './motion.js';

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

test('a vessel with fixes around the time is placed on them, held at either end', () => {
  const tracked = {
    lat: 9,
    lon: 9,
    motion: record.motion,
    fixes: [
      { atMs: 1_000, lat: 0, lon: 0, altitudeM: null },
      { atMs: 2_000, lat: 1, lon: 0, altitudeM: null },
      { atMs: 4_000, lat: 1, lon: 2, altitudeM: null },
    ],
  };
  assert.deepEqual(vesselPositionAt(tracked, 0), { lat: 0, lon: 0 });
  assert.deepEqual(vesselPositionAt(tracked, 9_000), { lat: 1, lon: 2 });
  const back = vesselPositionAt(tracked, 1_500);
  assert.ok(Math.abs(back.lat - 0.5) < 1e-3 && Math.abs(back.lon) < 1e-6);
  const on = vesselPositionAt(tracked, 3_000);
  assert.ok(Math.abs(on.lat - 1) < 1e-3 && Math.abs(on.lon - 1) < 1e-3);
});

test('fixes that stay in one place do not move a vessel', () => {
  const still = [
    { atMs: 0, lat: 1, lon: 2 },
    { atMs: 60_000, lat: 1, lon: 2 },
  ];
  assert.equal(fixesMove(still), false);
  assert.equal(
    fixesMove([...still, { atMs: 90_000, lat: 1.001, lon: 2 }]),
    true,
  );
  assert.equal(fixesMove(null), false);
});
