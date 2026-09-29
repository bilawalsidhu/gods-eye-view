import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCameraTrafficObservation,
  formatObservedTrafficAge,
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

test('age and class-mix helpers stay compact', () => {
  assert.equal(formatObservedTrafficAge(32_000), '32s ago');
  assert.equal(formatObservedTrafficAge(150_000), '3m ago');
  assert.equal(formatObservedTrafficAge(7_200_000), '2h ago');
  assert.equal(
    observedTrafficClassMix({ car: 86, heavyVehicle: 11, motorbike: 3 }),
    '86% car · 11% heavy vehicle · 3% motorbike',
  );
});
