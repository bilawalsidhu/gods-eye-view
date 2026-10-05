import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createModel } from './model.js';
import { createPolicyHelpers } from './policyHelpers.js';
import { WINDOW_DAYS } from './policy.js';

function setupModel() {
  const state = {};
  const parts = {};
  parts.policyHelpers = createPolicyHelpers({
    state,
    services: {},
    parts,
    source: {},
  });
  const model = createModel({ state, services: {}, parts, source: {} });
  return { model, parts };
}

test('finiteCoordinate normalizes finite numbers and rejects non-numeric or non-finite inputs', () => {
  const { model } = setupModel();
  assert.equal(model.finiteCoordinate(42.5), 42.5);
  assert.equal(model.finiteCoordinate('28.5619'), 28.5619);
  assert.equal(model.finiteCoordinate('-80.5772'), -80.5772);
  assert.equal(model.finiteCoordinate(0), 0);
  assert.equal(model.finiteCoordinate('0'), 0);
  assert.equal(model.finiteCoordinate(undefined), null);
  assert.equal(model.finiteCoordinate('invalid'), null);
  assert.equal(model.finiteCoordinate(Number.NaN), null);
  assert.equal(model.finiteCoordinate(Number.POSITIVE_INFINITY), null);
  assert.equal(model.finiteCoordinate(Number.NEGATIVE_INFINITY), null);
});

test('normalizePayloadFlights resolves payload metadata and masses from rocket, launch, and mission tiers', () => {
  const { model } = setupModel();

  // Empty payloads returns an empty array.
  assert.deepEqual(model.normalizePayloadFlights({}), []);
  assert.deepEqual(model.normalizePayloadFlights({ rocket: {} }), []);

  // Normalization across flight and nested payload attributes.
  const launch = {
    rocket: {
      payloads: [
        {
          id: 101,
          name: 'Starlink Group 6-50',
          type: { name: 'Communications' },
          manufacturer: { name: 'SpaceX' },
          operator: { name: 'SpaceX' },
          destination: 'Low Earth Orbit',
          amount: 23,
          mass: 16100,
        },
        {
          payload: {
            id: 'rideshare-cube',
            name: 'Research CubeSat',
            type: { name: 'Scientific' },
            mass: '12.5',
          },
          destination: 'Sun-synchronous Orbit',
        },
        {
          id: 'unspecified-mass',
          name: 'Classified Payload',
          mass: -50, // Negative mass rejected
          amount: 'not-a-number', // Fallback to 1
        },
      ],
    },
  };

  const normalized = model.normalizePayloadFlights(launch);
  assert.equal(normalized.length, 3);
  assert.deepEqual(normalized[0], {
    id: '101',
    name: 'Starlink Group 6-50',
    type: 'Communications',
    manufacturer: 'SpaceX',
    operator: 'SpaceX',
    destination: 'Low Earth Orbit',
    amount: 23,
    massKg: 16100,
  });
  assert.deepEqual(normalized[1], {
    id: 'rideshare-cube',
    name: 'Research CubeSat',
    type: 'Scientific',
    manufacturer: null,
    operator: null,
    destination: 'Sun-synchronous Orbit',
    amount: 1,
    massKg: 12.5,
  });
  assert.deepEqual(normalized[2], {
    id: 'unspecified-mass',
    name: 'Classified Payload',
    type: null,
    manufacturer: null,
    operator: null,
    destination: null,
    amount: 1,
    massKg: null,
  });
});

test('normalizeLanding captures recovery outcomes, destinations, and stage coordinates', () => {
  const { model } = setupModel();

  // Success recovery on droneship
  const recovered = model.normalizeLanding(
    {
      id: 55,
      type: { name: 'Core Stage' },
      launcher: { serial_number: 'B1083', status: { name: 'Active' } },
      reused: true,
      launcher_flight_number: 4,
      landing: {
        attempt: true,
        success: true,
        type: { name: 'ASDS' },
        landing_location: {
          name: 'Just Read the Instructions',
          latitude: 28.4,
          longitude: -74.2,
        },
        downrange_distance: 630,
        description: 'Droneship landing successful',
      },
    },
    'Fallback Booster',
    'LAUNCHER',
    0,
  );

  assert.deepEqual(recovered, {
    id: '55',
    category: 'LAUNCHER',
    name: 'Core Stage · B1083',
    serial: 'B1083',
    reused: true,
    flightNumber: 4,
    status: 'RECOVERED',
    attempted: true,
    success: true,
    recoveryType: 'ASDS',
    destination: 'Just Read the Instructions',
    description: 'Droneship landing successful',
    downrangeKm: 630,
    lat: 28.4,
    lon: -74.2,
  });

  // Failed landing attempt
  const lost = model.normalizeLanding(
    {
      landing: {
        attempt: true,
        success: false,
        landing_location: { name: 'Landing Zone 1' },
      },
    },
    'First Stage',
    'LAUNCHER',
    1,
  );
  assert.equal(lost.status, 'LOST');
  assert.equal(lost.success, false);
  assert.equal(lost.attempted, true);

  // Recovery attempt with undetermined outcome
  const attemptOnly = model.normalizeLanding(
    {
      landing: {
        attempt: true,
        success: null,
      },
    },
    'Upper Stage',
    'LAUNCHER',
    2,
  );
  assert.equal(attemptOnly.status, 'RECOVERY ATTEMPT');
  assert.equal(attemptOnly.success, null);
  assert.equal(attemptOnly.attempted, true);

  // No attempt, fallback category status
  const unattempted = model.normalizeLanding({}, 'Fallback', 'SPACECRAFT', 0);
  assert.equal(unattempted.status, 'NO RECOVERY DATA');
  assert.equal(unattempted.attempted, false);
  assert.equal(unattempted.success, null);
});

test('normalizeRecoveryStages aggregates launcher stages, spacecraft stages, and payload landings', () => {
  const { model } = setupModel();
  const launch = {
    rocket: {
      launcher_stage: [
        {
          id: 'booster-1',
          type: 'Booster',
          landing: { attempt: true, success: true },
        },
      ],
      spacecraft_stage: [
        {
          id: 'capsule-1',
          spacecraft: { serial_number: 'C206' },
          landing: { attempt: true, success: true },
        },
      ],
      payloads: [
        {
          id: 'sample-return-capsule',
          landing: { attempt: true, success: true },
        },
      ],
    },
  };
  const payloads = [{ type: 'Return Capsule', name: 'SRC-1' }];
  const stages = model.normalizeRecoveryStages(launch, payloads);
  assert.equal(stages.length, 3);
  assert.equal(stages[0].category, 'LAUNCHER');
  assert.equal(stages[1].category, 'SPACECRAFT');
  assert.equal(stages[2].category, 'PAYLOAD');
  assert.equal(stages[2].name, 'Return Capsule · SRC-1');
});

test('missionMarkerColor maps space agencies and commercial providers to distinctive palette colors', () => {
  const { model } = setupModel();

  const cases = [
    { launch: { provider: 'NASA' }, expected: '#ff9f43' },
    {
      launch: { name: 'Falcon 9 Block 5 | Starlink' },
      expected: '#4cc9f0',
    },
    { launch: { provider: 'Rocket Lab' }, expected: '#7bed9f' },
    { launch: { provider: 'ISRO' }, expected: '#ff66c4' },
    { launch: { name: 'Long March 5B' }, expected: '#ffd166' },
    { launch: { provider: 'Blue Origin' }, expected: '#a78bfa' },
    {
      launch: { provider: 'United Launch Alliance' },
      expected: '#f97316',
    },
    { launch: { provider: 'Arianespace' }, expected: '#60a5fa' },
    { launch: { provider: 'Relativity Space' }, expected: '#c084fc' },
    { launch: {}, expected: '#22e6e6' },
  ];

  for (const { launch, expected } of cases) {
    const color = model.missionMarkerColor(launch);
    const expectedColor = Cesium.Color.fromCssColorString(expected);
    assert.ok(
      Cesium.Color.equals(color, expectedColor),
      `Color mismatch for ${JSON.stringify(launch)}: expected ${expected}, got ${color.toCssColorString()}`,
    );
  }
});

test('normalizeRocketLaunches filters records by the 30-day window and pads coordinate bounds', () => {
  const { model } = setupModel();
  const now = new Date('2026-03-01T12:00:00.000Z');
  const cutoffMs = now.getTime() - WINDOW_DAYS * 86400000;

  const validLaunch = {
    id: 'launch-valid',
    name: 'Falcon 9 | Starlink Group 6-51',
    status: { name: 'Launch Successful' },
    net: '2026-02-20T15:00:00.000Z',
    pad: {
      name: 'SLC-40',
      latitude: '28.5619',
      longitude: '-80.5772',
      location: { name: 'Cape Canaveral' },
    },
    launch_service_provider: { name: 'SpaceX' },
    mission: {
      name: 'Starlink Group 6-51',
      description: 'L-band communications constellation',
      orbit: { name: 'Low Earth Orbit' },
    },
    rocket: { payloads: [] },
  };

  const oldLaunch = {
    ...validLaunch,
    id: 'launch-expired',
    net: new Date(cutoffMs - 3600000).toISOString(), // Outside 30-day cutoff
  };

  const futureLaunch = {
    ...validLaunch,
    id: 'launch-future',
    net: new Date(now.getTime() + 3600000).toISOString(), // Beyond now
  };

  const missingCoordsLaunch = {
    ...validLaunch,
    id: 'launch-no-coords',
    pad: { name: 'Secret Site' }, // No lat/lon
  };

  const fallbackCoordsLaunch = {
    ...validLaunch,
    id: 'launch-fallback-coords',
    pad: {
      name: 'VAFB Space Launch Complex 4E',
      location: { coordinates: '-120.6107,34.6321' }, // String lon,lat fallback
    },
  };

  const results = model.normalizeRocketLaunches(
    {
      results: [
        validLaunch,
        oldLaunch,
        futureLaunch,
        missingCoordsLaunch,
        fallbackCoordsLaunch,
      ],
    },
    now,
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'launch-valid');
  assert.equal(results[0].lat, 28.5619);
  assert.equal(results[0].lon, -80.5772);
  assert.equal(results[0].inWindow, true);
  assert.equal(results[0].source, 'Launch Library 2');

  assert.equal(results[1].id, 'launch-fallback-coords');
  assert.equal(results[1].lat, 34.6321);
  assert.equal(results[1].lon, -120.6107);
});

test('normalizeRocketLaunches parses mission event timeline duration offsets', () => {
  const { model } = setupModel();
  const now = new Date('2026-03-01T12:00:00.000Z');

  const launchWithTimeline = {
    id: 'launch-timeline',
    name: 'Atlas V | Kuiper Satellites',
    net: '2026-02-28T00:00:00.000Z',
    pad: { latitude: 28.5, longitude: -80.5 },
    timeline: [
      {
        type: { abbrev: 'T-0', name: 'Liftoff' },
        relative_time: 'PT0S',
      },
      {
        type: { abbrev: 'BECO', name: 'Booster Engine Cutoff' },
        relative_time: 'PT2M45S',
      },
      {
        name: 'Payload Fairing Jettison',
        relative_time: 'PT3M30S',
      },
    ],
  };

  const normalized = model.normalizeRocketLaunches([launchWithTimeline], now);
  assert.equal(normalized.length, 1);
  assert.deepEqual(normalized[0].timeline, [
    { name: 'T-0', relativeTime: 'PT0S', offsetSeconds: 0 },
    { name: 'BECO', relativeTime: 'PT2M45S', offsetSeconds: 165 },
    {
      name: 'Payload Fairing Jettison',
      relativeTime: 'PT3M30S',
      offsetSeconds: 210,
    },
  ]);
});
