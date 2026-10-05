import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyHelpers } from './policyHelpers.js';
import {
  SATELLITE_STANDALONE_DEFAULTS,
  LAUNCH_PAD_ZONE_MAX_CAMERA_HEIGHT_M,
  LAUNCH_PAD_ZONE_MAX_CAMERA_DISTANCE_M,
} from './policy.js';

function setupHelpers() {
  const state = {};
  const parts = {};
  const helpers = createPolicyHelpers({
    state,
    services: {},
    parts,
    source: {},
  });
  return { helpers, state };
}

test('parseMissionDurationSeconds parses signed ISO-8601 timeline durations and rejects malformed formats', () => {
  const { helpers } = setupHelpers();

  assert.equal(helpers.parseMissionDurationSeconds('PT0S'), 0);
  assert.equal(helpers.parseMissionDurationSeconds('PT8M40S'), 520);
  assert.equal(helpers.parseMissionDurationSeconds('-PT35M'), -2100);
  assert.equal(helpers.parseMissionDurationSeconds('PT1H'), 3600);
  assert.equal(helpers.parseMissionDurationSeconds('PT1H30M15S'), 5415);
  assert.equal(helpers.parseMissionDurationSeconds('P1D'), 86400);
  assert.equal(helpers.parseMissionDurationSeconds('-P2D'), -172800);
  assert.equal(helpers.parseMissionDurationSeconds('P1DT2H30M15S'), 95415);

  assert.equal(helpers.parseMissionDurationSeconds(''), null);
  assert.equal(helpers.parseMissionDurationSeconds(null), null);
  assert.equal(helpers.parseMissionDurationSeconds(undefined), null);
  assert.equal(helpers.parseMissionDurationSeconds('invalid'), null);
  assert.equal(helpers.parseMissionDurationSeconds('12:30'), null);
  assert.equal(helpers.parseMissionDurationSeconds('10 minutes'), null);
});

test('formatMissionEventTime formats UTC timestamps for globe overlays and falls back gracefully', () => {
  const { helpers } = setupHelpers();

  const formatted = helpers.formatMissionEventTime('2026-03-01T14:30:45.000Z');
  assert.equal(formatted, '2026-03-01\n14:30:45 UTC');

  const fromDate = helpers.formatMissionEventTime(
    new Date('2026-05-15T09:00:00.000Z'),
  );
  assert.equal(fromDate, '2026-05-15\n09:00:00 UTC');

  assert.equal(helpers.formatMissionEventTime(null), 'UNAVAILABLE');
  assert.equal(helpers.formatMissionEventTime(''), 'UNAVAILABLE');
  assert.equal(helpers.formatMissionEventTime('not-a-date'), 'UNAVAILABLE');
});

test('launchStatusAllowsOrbit distinguishes successful/planned orbital trajectories from launch failures', () => {
  const { helpers } = setupHelpers();

  assert.equal(helpers.launchStatusAllowsOrbit('Launch Successful'), true);
  assert.equal(helpers.launchStatusAllowsOrbit('Go for Launch'), true);
  assert.equal(helpers.launchStatusAllowsOrbit('To Be Determined'), true);
  assert.equal(helpers.launchStatusAllowsOrbit(null), true);
  assert.equal(helpers.launchStatusAllowsOrbit(''), true);

  assert.equal(helpers.launchStatusAllowsOrbit('Launch Failure'), false);
  assert.equal(helpers.launchStatusAllowsOrbit('Partial Failure'), false);
  assert.equal(helpers.launchStatusAllowsOrbit('Failure'), false);
  assert.equal(helpers.launchStatusAllowsOrbit('failed'), false);
  assert.equal(helpers.launchStatusAllowsOrbit('Mission Failed'), false);
});

test('missionPathPresentation describes orbit target, trajectory evidence, and replay availability', () => {
  const { helpers } = setupHelpers();

  // Successful mission with supplied trajectory points
  const supplied = helpers.missionPathPresentation(
    {
      status: 'Launch Successful',
      orbit: { name: 'Low Earth Orbit' },
      trajectory: [
        { latitude: 28.5, longitude: -80.5 },
        { latitude: 30.1, longitude: -78.2 },
      ],
    },
    false,
  );
  assert.deepEqual(supplied, {
    orbit: 'Low Earth Orbit',
    ascent: 'SUPPLIED TRAJECTORY POINTS',
    replayAvailable: false,
  });

  // Failed mission with planned orbit and reconstructed replay
  const failed = helpers.missionPathPresentation(
    {
      status: 'Launch Failure',
      orbit: 'Sun-synchronous Orbit',
      trajectory: [],
    },
    true,
  );
  assert.deepEqual(failed, {
    orbit: 'PLANNED · Sun-synchronous Orbit',
    ascent: 'RECONSTRUCTED ESTIMATE',
    replayAvailable: true,
  });

  // Mission without orbit and without replay
  const noOrbit = helpers.missionPathPresentation(
    {
      status: 'Success',
      orbit: null,
      trajectory: [],
    },
    false,
  );
  assert.deepEqual(noOrbit, {
    orbit: null,
    ascent: 'UNAVAILABLE',
    replayAvailable: false,
  });
});

test('releaseAircraftTracking stops camera tracking across flights and military layers', () => {
  const { helpers } = setupHelpers();
  const stoppedLayers = [];

  const mockDataManager = {
    layers: new Map([
      [
        'flights',
        {
          module: {
            stopTracking() {
              stoppedLayers.push('flights');
            },
          },
        },
      ],
      [
        'military',
        {
          module: {
            stopTracking() {
              stoppedLayers.push('military');
            },
          },
        },
      ],
      [
        'other',
        {
          module: {
            stopTracking() {
              stoppedLayers.push('other');
            },
          },
        },
      ],
    ]),
  };

  const releasedCount = helpers.releaseAircraftTracking(mockDataManager);
  assert.equal(releasedCount, 2);
  assert.deepEqual(stoppedLayers, ['flights', 'military']);

  // Gracefully handles empty or missing data manager
  assert.equal(helpers.releaseAircraftTracking(null), 0);
  assert.equal(helpers.releaseAircraftTracking({}), 0);
});

test('launchPadZoneVisible gates launch-pad highlight by layer activity, selection, and camera bounds', () => {
  const { helpers } = setupHelpers();

  const baseInput = {
    layerActive: true,
    selectedLaunchId: 'mission-alpha',
    launchId: 'mission-alpha',
    cameraHeightM: 50000,
    cameraDistanceM: 80000,
  };

  // Within limits
  assert.equal(helpers.launchPadZoneVisible(baseInput), true);

  // Inactive layer
  assert.equal(
    helpers.launchPadZoneVisible({ ...baseInput, layerActive: false }),
    false,
  );

  // Mismatched launch ID
  assert.equal(
    helpers.launchPadZoneVisible({ ...baseInput, launchId: 'mission-beta' }),
    false,
  );

  // Exceeds max camera altitude
  assert.equal(
    helpers.launchPadZoneVisible({
      ...baseInput,
      cameraHeightM: LAUNCH_PAD_ZONE_MAX_CAMERA_HEIGHT_M + 1000,
    }),
    false,
  );

  // Exceeds max camera distance
  assert.equal(
    helpers.launchPadZoneVisible({
      ...baseInput,
      cameraDistanceM: LAUNCH_PAD_ZONE_MAX_CAMERA_DISTANCE_M + 1000,
    }),
    false,
  );

  // Non-finite camera metrics
  assert.equal(
    helpers.launchPadZoneVisible({ ...baseInput, cameraHeightM: Number.NaN }),
    false,
  );
});

test('satelliteParams helpers configure temporary mission parameters and restore previous settings', () => {
  const { helpers } = setupHelpers();

  const userSettings = {
    catalog: 'sparse',
    showPoints: true,
    showOrbits: true,
    customField: 'test',
  };

  const missionParams = helpers.satelliteParamsForSpaceMissions(userSettings);
  assert.deepEqual(missionParams, {
    ...SATELLITE_STANDALONE_DEFAULTS,
    ...userSettings,
    catalog: 'dense',
    showPoints: false,
    showOrbits: false,
  });

  const restored = helpers.satelliteParamsAfterSpaceMissions(userSettings);
  assert.deepEqual(restored, {
    ...SATELLITE_STANDALONE_DEFAULTS,
    ...userSettings,
  });
});

test('missionDataCompleteness and missionRosterEntries rank missions while preserving original navigation indices', () => {
  const { helpers } = setupHelpers();

  const richLaunch = {
    id: 'rich',
    provider: 'SpaceX',
    mission: 'Starlink constellation deployment',
    missionName: 'Starlink 6-50',
    orbit: { name: 'LEO' },
    payloads: [{}, {}, {}],
    recoveryStages: [{}, {}],
    trajectory: [{}, {}, {}],
    timeline: [{}, {}],
    launchTime: '2026-02-20T12:00:00Z',
  };

  const sparseLaunch = {
    id: 'sparse',
    provider: null,
    mission: null,
    missionName: null,
    orbit: null,
    payloads: [],
    recoveryStages: [],
    trajectory: [],
    timeline: [],
    launchTime: '2026-02-25T12:00:00Z',
  };

  const richScore = helpers.missionDataCompleteness(richLaunch);
  const sparseScore = helpers.missionDataCompleteness(sparseLaunch);
  assert.ok(
    richScore > sparseScore,
    `Expected rich score (${richScore}) > sparse score (${sparseScore})`,
  );

  // In the original array, sparse is index 0 and rich is index 1.
  const entries = helpers.missionRosterEntries([sparseLaunch, richLaunch]);
  assert.equal(entries.length, 2);
  // Rich launch ranks first due to completeness score
  assert.equal(entries[0].launch.id, 'rich');
  assert.equal(entries[0].index, 1); // Preserves original index 1
  // Sparse launch ranks second
  assert.equal(entries[1].launch.id, 'sparse');
  assert.equal(entries[1].index, 0); // Preserves original index 0
});
