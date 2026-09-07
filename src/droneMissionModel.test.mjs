import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDroneRouteFromDraft,
  missionConfirmationSummary,
  normalizeDroneSettings,
} from './droneMissionModel.js';

const launch = { latitude: 30.2672, longitude: -97.7431 };
const destination = {
  type: 'area',
  center: { latitude: 30.28, longitude: -97.72 },
};

test('mission draft creates an ordered route with explicit destination area', () => {
  const settings = normalizeDroneSettings({ destinationRadiusMeters: 320 });
  const route = createDroneRouteFromDraft({
    launch,
    waypoints: [
      { id: 'west', latitude: 30.27, longitude: -97.74 },
      { id: 'east', latitude: 30.275, longitude: -97.73 },
    ],
    destination,
  }, settings);

  assert.deepEqual(route.waypoints.map(({ id }) => id), ['west', 'east']);
  assert.equal(route.destination.type, 'area');
  assert.equal(route.destination.radiusMeters, 320);
});

test('settings and confirmation retain deterministic demo provenance', () => {
  const settings = normalizeDroneSettings({
    minimumAglMeters: 75,
    groundSpeedMps: 12,
    maxClimbRateMps: 3,
    maxDescentRateMps: 2,
  });
  const route = createDroneRouteFromDraft({
    launch,
    destination: { type: 'point', point: destination.center },
  }, settings);
  const summary = missionConfirmationSummary(route, settings);

  assert.equal(summary.routePointCount, 2);
  assert.equal(summary.waypointCount, 0);
  assert.equal(summary.minimumAglMeters, 75);
  assert.equal(summary.provenance, 'SIMULATED / DEMO');
});

test('invalid flight constraints fail before terrain sampling', () => {
  assert.throws(
    () => normalizeDroneSettings({ groundSpeedMps: 0 }),
    /Ground speed must be greater than zero/,
  );
});

test('mission routes enforce point and distance safety limits', () => {
  assert.throws(
    () => createDroneRouteFromDraft({
      launch,
      waypoints: Array.from({ length: 63 }, (_, index) => ({
        id: `waypoint-${index}`,
        latitude: 30.2673 + index * 0.00001,
        longitude: -97.7431,
      })),
      destination: { type: 'point', point: destination.center },
    }),
    /at most 64 points/,
  );
  assert.throws(
    () => createDroneRouteFromDraft({
      launch: { latitude: 0, longitude: 0 },
      destination: { type: 'point', point: { latitude: 0, longitude: 10 } },
    }),
    /500 km demo limit/,
  );
});
