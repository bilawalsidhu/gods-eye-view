import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createObservedTraffic,
  createObservedTrafficSource,
  emptyObservedTrafficSnapshot,
  normalizeObservedTrafficRecord,
  normalizeObservedTrafficSnapshot,
} from './observed.js';

const NOW = Date.parse('2026-09-29T02:30:00Z');

function validRecord(overrides = {}) {
  return {
    id: 'cam-12:westbound',
    sourceId: 'city-vision',
    cameraId: 'cam-12',
    observedAt: NOW - 15_000,
    windowStart: NOW - 60_000,
    windowEnd: NOW - 10_000,
    geometry: {
      type: 'road-segment',
      coordinates: [
        [-87.63, 41.88],
        [-87.629, 41.88],
      ],
    },
    flow: {
      vehiclesPerMin: 18,
      counts: { car: 15, heavyVehicle: 3 },
    },
    quality: { status: 'measured', score: 0.84 },
    provenance: { source: 'City traffic camera', method: 'external-cv' },
    ...overrides,
  };
}

test('normalizes a provider-neutral observed traffic record', () => {
  const record = normalizeObservedTrafficRecord(validRecord());
  assert.ok(record);
  assert.equal(record.id, 'cam-12:westbound');
  assert.equal(record.sourceId, 'city-vision');
  assert.equal(record.cameraId, 'cam-12');
  assert.equal(record.geometry.type, 'road-segment');
  assert.deepEqual(record.flow.counts, { car: 15, heavyVehicle: 3 });
  assert.deepEqual(record.quality, { status: 'measured', score: 0.84 });
  assert.equal(record.provenance.method, 'external-cv');
});

test('malformed siblings are dropped and make the snapshot partial', () => {
  const snapshot = normalizeObservedTrafficSnapshot(
    {
      source: 'fixture',
      records: [
        validRecord(),
        validRecord({ id: '' }),
        validRecord({
          id: 'bad-geometry',
          geometry: { type: 'road-segment', coordinates: [[500, 95]] },
        }),
      ],
    },
    { now: NOW },
  );
  assert.equal(snapshot.state, 'partial');
  assert.equal(snapshot.received, 3);
  assert.equal(snapshot.accepted, 1);
  assert.equal(snapshot.dropped, 2);
  assert.equal(snapshot.records[0].id, 'cam-12:westbound');
});

test('fresh and stale observations remain distinct', () => {
  const fresh = normalizeObservedTrafficSnapshot(
    { records: [validRecord()] },
    { now: NOW, staleAfterMs: 120_000 },
  );
  assert.equal(fresh.state, 'fresh');
  assert.equal(fresh.stale, false);

  const stale = normalizeObservedTrafficSnapshot(
    {
      records: [
        validRecord({
          observedAt: NOW - 900_000,
          windowStart: NOW - 960_000,
          windowEnd: NOW - 900_000,
        }),
      ],
    },
    { now: NOW, staleAfterMs: 120_000 },
  );
  assert.equal(stale.state, 'stale');
  assert.equal(stale.stale, true);
  assert.equal(stale.staleCount, 1);
  assert.equal(stale.records.length, 1, 'stale evidence is retained, not relabeled fresh');
});

test('a malformed records container is an error, not an empty success', () => {
  const snapshot = normalizeObservedTrafficSnapshot(
    { source: 'fixture', records: { not: 'an-array' } },
    { now: NOW },
  );
  assert.equal(snapshot.state, 'error');
  assert.equal(snapshot.error, 'Observed traffic source unavailable');
});

test('source errors use fixed presentation-safe copy', () => {
  const snapshot = normalizeObservedTrafficSnapshot(
    {
      source: 'fixture',
      error: 'upstream token=super-secret exploded',
      records: [],
    },
    { now: NOW },
  );
  assert.equal(snapshot.state, 'error');
  assert.equal(snapshot.error, 'Observed traffic source unavailable');
  assert.ok(!JSON.stringify(snapshot).includes('super-secret'));
});

test('an absent source is inert and unconfigured', async () => {
  const source = createObservedTrafficSource();
  assert.equal(source.configured, false);
  assert.deepEqual(
    await source.request(
      { south: 41, west: -88, north: 42, east: -87 },
      { now: NOW },
    ),
    emptyObservedTrafficSnapshot(),
  );
});

test('a configured source normalizes its provider response', async () => {
  const calls = [];
  const source = createObservedTrafficSource({
    label: 'corridor fixture',
    read(query) {
      calls.push(query);
      return {
        records: [validRecord()],
        partial: false,
      };
    },
  });
  const query = { corridorId: 'sr-90' };
  const snapshot = await source.request(query, { now: NOW });
  assert.deepEqual(calls, [query]);
  assert.equal(snapshot.state, 'fresh');
  assert.equal(snapshot.source, 'corridor fixture');
  assert.equal(snapshot.accepted, 1);
});

test('provider failures become error snapshots while cancellation still propagates', async () => {
  const failed = createObservedTrafficSource({
    read() {
      throw new Error('provider secret should not surface');
    },
  });
  const failure = await failed.request({}, { now: NOW });
  assert.equal(failure.state, 'error');
  assert.equal(failure.error, 'Observed traffic source unavailable');

  const cancelled = createObservedTrafficSource({
    read() {
      throw new DOMException('cancelled', 'AbortError');
    },
  });
  await assert.rejects(() => cancelled.request({}, { now: NOW }), {
    name: 'AbortError',
  });
});

test('null metrics and records without observed evidence fail closed', () => {
  assert.equal(
    normalizeObservedTrafficRecord(
      validRecord({
        flow: { vehiclesPerMin: null, counts: {} },
        movements: [],
      }),
    ),
    null,
  );

  const zero = normalizeObservedTrafficRecord(
    validRecord({
      flow: { vehiclesPerMin: 0, counts: {} },
    }),
  );
  assert.ok(zero);
  assert.equal(zero.flow.vehiclesPerMin, 0);
});

test('record and geometry bounds degrade the snapshot to partial', () => {
  const tooManyPoints = Array.from({ length: 257 }, (_, index) => [
    -87.63 + index * 0.000001,
    41.88,
  ]);
  const snapshot = normalizeObservedTrafficSnapshot(
    {
      records: [
        validRecord(),
        validRecord({
          id: 'too-large',
          geometry: {
            type: 'road-segment',
            coordinates: tooManyPoints,
          },
        }),
      ],
    },
    { now: NOW },
  );
  assert.equal(snapshot.state, 'partial');
  assert.equal(snapshot.accepted, 1);
  assert.equal(snapshot.dropped, 1);
});

test('observed snapshot subscribers receive committed snapshots only', async () => {
  const state = {
    _observedTrafficSnapshot: emptyObservedTrafficSnapshot(),
    _observedTrafficLoading: false,
    _observedTrafficGeneration: 0,
    _observedTrafficListeners: new Set(),
  };
  const observed = createObservedTraffic({
    state,
    observedSource: {
      async request() {
        return normalizeObservedTrafficSnapshot(
          { source: 'fixture', records: [validRecord()] },
          { now: NOW },
        );
      },
    },
  });
  const states = [];
  const unsubscribe = observed.methods.subscribeObservedTraffic((value) =>
    states.push(value.state),
  );
  await observed.methods.refreshObservedTraffic({}, { now: NOW });
  unsubscribe();
  await observed.methods.refreshObservedTraffic({}, { now: NOW });
  assert.deepEqual(states, ['unconfigured', 'fresh']);
});

test('later observed refresh owns state when an older request settles late', async () => {
  const pending = [];
  const observedSource = {
    request(query) {
      return new Promise((resolve) => pending.push({ query, resolve }));
    },
  };
  const state = {
    _observedTrafficSnapshot: emptyObservedTrafficSnapshot(),
    _observedTrafficLoading: false,
    _observedTrafficGeneration: 0,
  };
  const observed = createObservedTraffic({ state, observedSource });

  const first = observed.methods.refreshObservedTraffic({ id: 'first' });
  const second = observed.methods.refreshObservedTraffic({ id: 'second' });

  pending[1].resolve(
    normalizeObservedTrafficSnapshot(
      { source: 'second', records: [validRecord({ id: 'second' })] },
      { now: NOW },
    ),
  );
  await second;
  assert.equal(
    observed.methods.getObservedTrafficSnapshot().records[0].id,
    'second',
  );

  pending[0].resolve(
    normalizeObservedTrafficSnapshot(
      { source: 'first', records: [validRecord({ id: 'first' })] },
      { now: NOW },
    ),
  );
  await first;
  assert.equal(
    observed.methods.getObservedTrafficSnapshot().records[0].id,
    'second',
    'stale completion must not replace the newer snapshot',
  );
});

test('intersection geometry accepts one point and invalid windows fail closed', () => {
  assert.ok(
    normalizeObservedTrafficRecord(
      validRecord({
        geometry: {
          type: 'intersection',
          coordinates: [-87.63, 41.88],
        },
      }),
    ),
  );
  assert.equal(
    normalizeObservedTrafficRecord(
      validRecord({
        windowStart: NOW,
        windowEnd: NOW - 1,
      }),
    ),
    null,
  );
});
