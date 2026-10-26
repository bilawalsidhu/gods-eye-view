import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCameraTrafficObservation,
  formatObservedTrafficAge,
  indexCameraTrafficObservations,
  observedTrafficClassMix,
  summarizeCameraTrafficObservation,
} from './trafficObservations.js';

const NOW = Date.parse('2026-09-29T04:00:00Z');

function record(overrides = {}) {
  return {
    id: 'cam-1:westbound',
    sourceId: 'city-observer',
    cameraId: 'cam-1',
    observedAt: NOW - 20_000,
    windowStart: NOW - 60_000,
    windowEnd: NOW - 10_000,
    flow: {
      vehiclesPerMin: 18,
      counts: { car: 15, heavyVehicle: 3 },
    },
    quality: { status: 'measured', score: 0.9 },
    provenance: { source: 'City traffic camera' },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    configured: true,
    source: 'fixture',
    records: [record()],
    partial: false,
    error: null,
    ...overrides,
  };
}

test('unconfigured observation state is absent from CCTV presentation', () => {
  assert.equal(
    summarizeCameraTrafficObservation(
      { configured: false, records: [] },
      'cam-1',
      { now: NOW },
    ),
    null,
  );
});

test('configured source with no camera record is explicitly unknown', () => {
  const summary = summarizeCameraTrafficObservation(
    snapshot({ records: [] }),
    'cam-1',
    { now: NOW },
  );
  assert.equal(summary.state, 'unknown');
  assert.equal(summary.statusLabel, 'TRAFFIC OBS · UNKNOWN');
  assert.deepEqual(summary.cardDetails, []);
});

test('camera index retains one freshest record per camera', () => {
  const older = record({
    id: 'older',
    windowEnd: NOW - 40_000,
    flow: { vehiclesPerMin: 100, counts: { car: 100 } },
  });
  const newer = record({
    id: 'newer',
    windowEnd: NOW - 5_000,
    flow: { vehiclesPerMin: 12, counts: { car: 9, heavyVehicle: 3 } },
  });
  const other = record({
    id: 'other',
    cameraId: 'cam-2',
    windowEnd: NOW - 1_000,
  });
  const index = indexCameraTrafficObservations(
    snapshot({ records: [older, other, newer] }),
  );
  assert.equal(index.size, 2);
  assert.equal(index.get('cam-1').id, 'newer');
  assert.equal(index.get('cam-2').id, 'other');
});

test('freshest matching camera record wins without summing approaches', () => {
  const older = record({
    id: 'older',
    windowEnd: NOW - 40_000,
    flow: { vehiclesPerMin: 100, counts: { car: 100 } },
  });
  const newer = record({
    id: 'newer',
    windowEnd: NOW - 5_000,
    flow: { vehiclesPerMin: 12, counts: { car: 9, heavyVehicle: 3 } },
  });
  const summary = summarizeCameraTrafficObservation(
    snapshot({ records: [older, newer] }),
    'cam-1',
    { now: NOW },
  );
  assert.equal(summary.recordId, 'newer');
  assert.equal(summary.primary, '12 veh/min');
  assert.equal(summary.classMix, '75% car · 25% heavy vehicle');
  assert.equal(summary.qualityLabel, 'Q measured 90%');
  assert.match(
    formatCameraTrafficObservation(summary),
    /Q measured 90%.*City traffic camera/,
  );
});

test('preindexed lookup returns the same summary without rescanning records', () => {
  const data = snapshot({
    records: [
      record({ id: 'cam-1-current' }),
      record({ id: 'cam-2-current', cameraId: 'cam-2' }),
    ],
  });
  const index = indexCameraTrafficObservations(data);
  const summary = summarizeCameraTrafficObservation(data, 'cam-2', {
    now: NOW,
    recordIndex: index,
  });
  assert.equal(summary.recordId, 'cam-2-current');
});

test('stale measurements remain visible but are clearly stale', () => {
  const summary = summarizeCameraTrafficObservation(
    snapshot({
      records: [
        record({
          observedAt: NOW - 700_000,
          windowStart: NOW - 760_000,
          windowEnd: NOW - 700_000,
        }),
      ],
    }),
    'cam-1',
    { now: NOW, staleAfterMs: 120_000 },
  );
  assert.equal(summary.state, 'stale');
  assert.equal(summary.statusLabel, 'TRAFFIC OBS · STALE');
  assert.match(formatCameraTrafficObservation(summary), /12m ago/);
});

test('provider errors do not turn last evidence into current evidence', () => {
  const summary = summarizeCameraTrafficObservation(
    snapshot({ error: 'safe normalized error' }),
    'cam-1',
    { now: NOW },
  );
  assert.equal(summary.state, 'stale');
  assert.equal(summary.statusLabel, 'TRAFFIC OBS · STALE');

  const unavailable = summarizeCameraTrafficObservation(
    snapshot({ records: [], error: 'safe normalized error' }),
    'cam-1',
    { now: NOW },
  );
  assert.equal(unavailable.state, 'unavailable');
});

test('partial snapshot is visible without overriding the measurement', () => {
  const summary = summarizeCameraTrafficObservation(
    snapshot({ partial: true }),
    'cam-1',
    { now: NOW },
  );
  assert.equal(summary.state, 'partial');
  assert.equal(summary.primary, '18 veh/min');
  assert.equal(summary.statusLabel, 'TRAFFIC OBS · PARTIAL');
});

test('camera status respects the source freshness budget for mixed-age evidence', () => {
  const old = record({
    id: 'cam-1:old',
    observedAt: NOW - 180_000,
    windowStart: NOW - 240_000,
    windowEnd: NOW - 180_000,
  });
  const current = record({
    id: 'cam-2:current',
    cameraId: 'cam-2',
    observedAt: NOW - 20_000,
    windowStart: NOW - 60_000,
    windowEnd: NOW - 10_000,
  });
  const shortBudget = snapshot({
    records: [old, current],
    staleAfterMs: 60_000,
    staleCount: 1,
    partial: true,
    state: 'partial',
  });
  const stale = summarizeCameraTrafficObservation(shortBudget, 'cam-1', {
    now: NOW,
  });
  const fresh = summarizeCameraTrafficObservation(shortBudget, 'cam-2', {
    now: NOW,
  });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.statusLabel, 'TRAFFIC OBS · STALE');
  assert.equal(
    fresh.state,
    'partial',
    'other-camera staleness does not expire this record',
  );

  const longBudget = snapshot({ records: [old], staleAfterMs: 600_000 });
  assert.equal(
    summarizeCameraTrafficObservation(longBudget, 'cam-1', { now: NOW }).state,
    'fresh',
  );
  assert.equal(
    summarizeCameraTrafficObservation(longBudget, 'cam-1', {
      now: NOW,
      staleAfterMs: 60_000,
    }).state,
    'stale',
    'explicit presenter override wins over a snapshot budget',
  );
});

test('far-future CCTV records stay stale while valid sibling cameras remain visible', () => {
  const future = NOW + 365 * 24 * 60 * 60 * 1000;
  const valid = record({ id: 'cam-2:current', cameraId: 'cam-2' });
  const suspect = [
    record({ observedAt: future }),
    record({ windowStart: future, windowEnd: future }),
    record({ windowEnd: future }),
  ];
  for (const farFuture of suspect) {
    const data = snapshot({
      records: [farFuture, valid],
      state: 'partial',
      partial: true,
      staleCount: 1,
      staleAfterMs: 600_000,
    });
    const stale = summarizeCameraTrafficObservation(data, 'cam-1', {
      now: NOW,
    });
    assert.equal(stale.state, 'stale');
    assert.equal(stale.statusLabel, 'TRAFFIC OBS · STALE');
    assert.equal(
      summarizeCameraTrafficObservation(data, 'cam-2', { now: NOW }).state,
      'partial',
      'another camera remains valid despite one suspicious clock',
    );
  }

  const near = record({
    observedAt: NOW + 60_000,
    windowStart: NOW,
    windowEnd: NOW + 60_000,
  });
  const beyond = record({
    observedAt: NOW + 60_001,
    windowStart: NOW,
    windowEnd: NOW + 60_001,
  });
  assert.equal(
    summarizeCameraTrafficObservation(snapshot({ records: [near] }), 'cam-1', {
      now: NOW,
    }).state,
    'fresh',
    'bounded provider clock skew remains valid',
  );
  assert.equal(
    summarizeCameraTrafficObservation(snapshot({ records: [beyond] }), 'cam-1', {
      now: NOW,
    }).state,
    'stale',
  );
});

test('age and class-mix helpers stay compact', () => {
  assert.equal(formatObservedTrafficAge(32_000), '32s ago');
  assert.equal(formatObservedTrafficAge(150_000), '3m ago');
  assert.equal(formatObservedTrafficAge(7_200_000), '2h ago');
  assert.equal(
    observedTrafficClassMix({ car: 86, heavyVehicle: 11, motorbike: 3 }),
    '86% car · 11% heavy vehicle · 3% motorbike',
  );
});
