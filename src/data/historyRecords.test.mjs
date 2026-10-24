import test from 'node:test';
import assert from 'node:assert/strict';
import { FIX_FLAGS } from './contactPlayback.js';
import {
  HISTORY_STORED_FLAGS,
  compareUtf8,
  historyCovers,
  historyMovingFeatures,
  historyPlaybackFixes,
  mergeHistoryCoverage,
  normalizeHistoryRecord,
} from './historyRecords.js';
import { createMemoryHistoryStore } from '../testSupport/historyMemoryStore.mjs';
import {
  HISTORY_CONFORMANCE,
  runHistoryConformance,
} from '../testSupport/historyConformance.mjs';

const T0 = Date.parse('2026-10-25T10:00:00Z');
const record = (t, extra = {}) => ({
  source: 'adsb',
  key: 'a1b2c3',
  t,
  lat: 30 + t / 1e9,
  lon: -97,
  timeKind: 'vehicle',
  provenance: 'observed',
  ...extra,
});

// The reference store must pass its own suite, or the suite proves nothing
// about the stores it is run on.
runHistoryConformance({
  test,
  label: 'reference store',
  open: (options) => createMemoryHistoryStore(options),
});

test('the conformance cases cover each clause of the contract once', () => {
  const names = HISTORY_CONFORMANCE.cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of [
    'round-trip',
    'time-kind',
    'provenance',
    'repeat-and-conflict',
    'midnight',
    'utf8-key-order',
    'paging-ties',
    'cursor-binding',
    'validation',
    'coverage',
    'retention',
  ])
    assert.ok(names.includes(name), name);
  for (const c of HISTORY_CONFORMANCE.cases) assert.ok(c.clause.length > 20);
});

test('UTF-8 byte order differs from UTF-16 order where it matters', () => {
  const pair = ['\u{1F600}', '～'];
  assert.deepEqual([...pair].sort(), ['\u{1F600}', '～']);
  assert.deepEqual([...pair].sort(compareUtf8), ['～', '\u{1F600}']);
  assert.equal(compareUtf8('a', 'ab') < 0, true);
  assert.equal(compareUtf8('same', 'same'), 0);
});

test('normalised records are fresh objects without negative zero', () => {
  const input = record(T0, { lat: -0, heightM: -0, flags: FIX_FLAGS.LIVE });
  const { record: out } = normalizeHistoryRecord(input);
  assert.notEqual(out, input);
  assert.ok(Object.is(out.lat, 0) && Object.is(out.heightM, 0));
  assert.equal(out.flags, 0);
  assert.ok(Number.isNaN(out.bearingDeg) && Number.isNaN(out.receivedAt));
  assert.equal(HISTORY_STORED_FLAGS, FIX_FLAGS.BREAK | FIX_FLAGS.FLOOR);
  assert.equal(normalizeHistoryRecord(null).reason, 'malformed');
  assert.equal(
    normalizeHistoryRecord(record(T0, { key: 'a\0b' })).reason,
    'key',
  );
});

test('coverage merges overlap and touching ends, and only covers whole spans', () => {
  const merged = mergeHistoryCoverage([
    { fromMs: 30, toMs: 40 },
    { fromMs: 0, toMs: 10 },
    { fromMs: 10, toMs: 20 },
    { fromMs: 5, toMs: 8 },
  ]);
  assert.deepEqual(merged, [
    { fromMs: 0, toMs: 20 },
    { fromMs: 30, toMs: 40 },
  ]);
  assert.ok(historyCovers(merged, 0, 20));
  assert.ok(!historyCovers(merged, 15, 35));
  assert.ok(!historyCovers(merged, 20.5, 29));
  assert.deepEqual(
    mergeHistoryCoverage(
      [
        { fromMs: 0, toMs: 10 },
        { fromMs: 12, toMs: 20 },
      ],
      2,
    ),
    [{ fromMs: 0, toMs: 20 }],
  );
});

test('playback fixes break where the recorder was not running', () => {
  const records = [0, 10_000, 20_000, 60_000, 70_000].map((dt) =>
    record(T0 + dt, { timeKind: dt === 70_000 ? 'receipt' : 'vehicle' }),
  );
  const coverage = [
    { fromMs: T0 - 5000, toMs: T0 + 25_000 },
    { fromMs: T0 + 55_000, toMs: T0 + 80_000 },
  ];
  const fixes = historyPlaybackFixes([...records].reverse(), { coverage });
  assert.deepEqual(
    fixes.map((f) => f.t - T0),
    [0, 10_000, 20_000, 60_000, 70_000],
  );
  assert.deepEqual(
    fixes.map((f) => Boolean(f.flags & FIX_FLAGS.BREAK)),
    [false, false, false, true, false],
  );
  assert.ok(fixes.slice(0, 4).every((f) => f.flags & FIX_FLAGS.VEHICLE_TIME));
  assert.ok(fixes[4].flags & FIX_FLAGS.RECEIPT_TIME);
  assert.ok(!(fixes[4].flags & FIX_FLAGS.VEHICLE_TIME));
  // No coverage: no span is known to be continuous.
  assert.ok(
    historyPlaybackFixes(records)
      .slice(1)
      .every((f) => f.flags & FIX_FLAGS.BREAK),
  );
  // Tolerance joins a short hole in coverage; without it the hole breaks.
  const holed = [
    { fromMs: T0, toMs: T0 + 10_000 },
    { fromMs: T0 + 10_500, toMs: T0 + 20_000 },
  ];
  const span = [record(T0 + 5000), record(T0 + 15_000)];
  assert.ok(
    historyPlaybackFixes(span, { coverage: holed })[1].flags & FIX_FLAGS.BREAK,
  );
  assert.ok(
    !(
      historyPlaybackFixes(span, { coverage: holed, toleranceMs: 500 })[1]
        .flags & FIX_FLAGS.BREAK
    ),
  );
  // A stored BREAK survives full coverage.
  const stored = historyPlaybackFixes(
    [record(T0), record(T0 + 1000, { flags: FIX_FLAGS.BREAK })],
    { coverage: [{ fromMs: T0, toMs: T0 + 1000 }] },
  );
  assert.ok(stored[1].flags & FIX_FLAGS.BREAK);
});

test('playback fixes refuse to mix contacts or provenances', () => {
  for (const other of [
    { key: 'other' },
    { source: 'ais' },
    { provenance: 'simulated' },
  ])
    assert.throws(
      () => historyPlaybackFixes([record(T0), record(T0 + 1000, other)]),
      TypeError,
    );
});

test('MF-JSON export splits segments at outages and keeps time order', () => {
  const records = [0, 10_000, 20_000, 60_000, 70_000, 200_000].map((dt) =>
    record(T0 + dt, { heightM: 1000 + dt / 1000 }),
  );
  records[5].heightM = NaN;
  const coverage = [
    { fromMs: T0, toMs: T0 + 20_000 },
    { fromMs: T0 + 50_000, toMs: T0 + 80_000 },
  ];
  const collection = historyMovingFeatures(records, { coverage });
  assert.equal(collection.type, 'FeatureCollection');
  const geometries = collection.features.map((f) => f.temporalGeometry);
  assert.deepEqual(
    geometries.map((g) => g.datetimes.length),
    [3, 2, 1],
  );
  assert.deepEqual(
    geometries.map((g) => g.interpolation),
    ['Linear', 'Linear', 'Discrete'],
  );
  assert.equal(geometries[0].datetimes[0], '2026-10-25T10:00:00.000Z');
  assert.deepEqual(geometries[0].coordinates[0], [-97, records[0].lat, 1000]);
  // A segment with an unknown height is two-dimensional throughout.
  assert.equal(geometries[2].coordinates[0].length, 2);
  const mixed = historyMovingFeatures(
    [record(T0, { heightM: 100 }), record(T0 + 1000)],
    { coverage: [{ fromMs: T0, toMs: T0 + 1000 }] },
  ).features[0].temporalGeometry.coordinates;
  assert.deepEqual(
    mixed.map((c) => c.length),
    [2, 2],
  );
  for (const geometry of geometries) {
    assert.equal(geometry.type, 'MovingPoint');
    assert.equal(geometry.datetimes.length, geometry.coordinates.length);
    const times = geometry.datetimes.map(Date.parse);
    assert.deepEqual(
      times,
      [...times].sort((a, b) => a - b),
    );
  }
  assert.deepEqual(collection.features[0].properties, {
    source: 'adsb',
    key: 'a1b2c3',
    provenance: 'observed',
    timeKinds: ['vehicle'],
  });
  assert.equal(
    new Set(collection.features.map((f) => f.id)).size,
    collection.features.length,
  );
  assert.deepEqual(historyMovingFeatures([]), {
    type: 'FeatureCollection',
    features: [],
  });
});
