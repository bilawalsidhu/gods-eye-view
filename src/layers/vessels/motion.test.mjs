import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fixesMove,
  greatCircleAt,
  vesselPositionAt,
  vesselSpanAt,
} from './motion.js';

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

const fixes = [
  { atMs: 1_000, lat: 0, lon: 0 },
  { atMs: 2_000, lat: 0, lon: 1 },
  { atMs: 3_000, lat: 1, lon: 1 },
];

test('vesselSpanAt holds at the first fix before it, until it', () => {
  assert.deepEqual(vesselSpanAt({ fixes }, 500), {
    kind: 'hold',
    lat: 0,
    lon: 0,
    fromMs: -Infinity,
    untilMs: 1_000,
  });
});

test('vesselSpanAt runs from the fix at or before the time to the next, ending after it', () => {
  for (const [atMs, t0, t1] of [
    [1_000, 1_000, 2_000],
    [1_999, 1_000, 2_000],
    [2_000, 2_000, 3_000],
    [2_500, 2_000, 3_000],
  ]) {
    const span = vesselSpanAt({ fixes }, atMs);
    assert.equal(span.kind, 'move');
    assert.deepEqual([span.t0, span.t1], [t0, t1], `at ${atMs}`);
    assert.ok(span.t1 > atMs);
  }
  // A degree of longitude on the equator.
  assert.ok(Math.abs(vesselSpanAt({ fixes }, 1_500).metres - 111_195) < 10);
});

test('vesselSpanAt holds at the last fix from it on', () => {
  assert.deepEqual(vesselSpanAt({ fixes }, 3_000), {
    kind: 'hold',
    lat: 1,
    lon: 1,
    fromMs: 3_000,
    untilMs: Infinity,
  });
});

test("vesselSpanAt follows a record's one move, and nothing for none", () => {
  assert.equal(vesselSpanAt(record, 500).untilMs, 1_000);
  const span = vesselSpanAt(record, 1_500);
  assert.equal(span.kind, 'move');
  assert.deepEqual([span.lat0, span.lat1], [0, 1]);
  assert.deepEqual(vesselSpanAt(record, 9_000), {
    kind: 'hold',
    lat: 1,
    lon: 1,
    fromMs: record.motion.toMs,
    untilMs: Infinity,
  });
  assert.equal(vesselSpanAt({ lat: 1, lon: 1 }, 1_500), null);
});

test('vesselSpanAt agrees with vesselPositionAt along the span', () => {
  for (const atMs of [1_000, 1_250, 2_000, 2_750]) {
    const span = vesselSpanAt({ fixes }, atMs);
    const at = greatCircleAt(
      span.lat0,
      span.lon0,
      span.lat1,
      span.lon1,
      (atMs - span.t0) / (span.t1 - span.t0),
    );
    const expected = vesselPositionAt({ fixes }, atMs);
    assert.ok(Math.abs(at.lat - expected.lat) < 1e-9);
    assert.ok(Math.abs(at.lon - expected.lon) < 1e-9);
  }
});
