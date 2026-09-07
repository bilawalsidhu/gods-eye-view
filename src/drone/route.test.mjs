import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RouteValidationError,
  createRoute,
  getRoutePoints,
  insertWaypoint,
  moveWaypoint,
  removeWaypoint,
  reorderWaypoint,
} from './route.js';

function baseRoute() {
  return createRoute({
    launch: { latitude: 60.1, longitude: 24.8 },
    waypoints: [
      { id: 'alpha', latitude: 60.11, longitude: 24.82 },
      { id: 'bravo', latitude: 60.12, longitude: 24.84 },
    ],
    destination: { latitude: 60.13, longitude: 24.86 },
  });
}

test('route models launch, ordered waypoints, and a point destination immutably', () => {
  const route = baseRoute();
  assert.equal(route.destination.type, 'point');
  assert.deepEqual(getRoutePoints(route).map(({ latitude }) => latitude), [60.1, 60.11, 60.12, 60.13]);
  assert.ok(Object.isFrozen(route));
  assert.ok(Object.isFrozen(route.waypoints));
  assert.ok(route.waypoints.every(Object.isFrozen));
  assert.throws(() => route.waypoints.push({}), TypeError);
});

test('route supports no intermediate waypoints and an area destination', () => {
  const route = createRoute({
    launch: { lat: 35, lon: -106 },
    destination: {
      type: 'area',
      center: { lat: 35.01, lon: -106.02 },
      radiusMeters: 75,
    },
  });
  assert.equal(route.waypoints.length, 0);
  assert.equal(route.destination.radiusMeters, 75);
  assert.equal(getRoutePoints(route).at(-1), route.destination.center);
});

test('route validates coordinates, destination type, radius, and distinct points', () => {
  assert.throws(
    () => createRoute({ launch: { latitude: 91, longitude: 0 }, destination: { latitude: 0, longitude: 0 } }),
    RouteValidationError,
  );
  assert.throws(
    () => createRoute({ launch: { latitude: 0, longitude: 0 }, destination: { type: 'circle' } }),
    /destination.type/,
  );
  assert.throws(
    () => createRoute({
      launch: { latitude: 0, longitude: 0 },
      destination: { type: 'area', center: { latitude: 1, longitude: 1 }, radiusMeters: 0 },
    }),
    /radiusMeters/,
  );
  assert.throws(
    () => createRoute({ launch: { latitude: 1, longitude: 1 }, destination: { latitude: 1, longitude: 1 } }),
    /must be distinct/,
  );
});

test('route generates stable waypoint ids and rejects duplicates', () => {
  const route = createRoute({
    launch: { latitude: 0, longitude: 0 },
    waypoints: [{ latitude: 0, longitude: 0.01 }, { latitude: 0, longitude: 0.02 }],
    destination: { latitude: 0, longitude: 0.03 },
  });
  assert.deepEqual(route.waypoints.map(({ id }) => id), ['waypoint-1', 'waypoint-2']);
  assert.throws(
    () => createRoute({
      launch: { latitude: 0, longitude: 0 },
      waypoints: [
        { id: 'same', latitude: 0, longitude: 0.01 },
        { id: 'same', latitude: 0, longitude: 0.02 },
      ],
      destination: { latitude: 0, longitude: 0.03 },
    }),
    /ids must be unique/,
  );
});

test('insertWaypoint returns a new route without mutating the source', () => {
  const original = baseRoute();
  const edited = insertWaypoint(original, 1, { latitude: 60.115, longitude: 24.83 });
  assert.notEqual(edited, original);
  assert.deepEqual(original.waypoints.map(({ id }) => id), ['alpha', 'bravo']);
  assert.deepEqual(edited.waypoints.map(({ id }) => id), ['alpha', 'waypoint-1', 'bravo']);
});

test('moveWaypoint preserves identity and source values', () => {
  const original = baseRoute();
  const edited = moveWaypoint(original, 0, { latitude: 60.105, longitude: 24.81 });
  assert.deepEqual(original.waypoints[0], { id: 'alpha', latitude: 60.11, longitude: 24.82 });
  assert.deepEqual(edited.waypoints[0], { id: 'alpha', latitude: 60.105, longitude: 24.81 });
});

test('reorderWaypoint changes only order and no-op retains identity', () => {
  const original = baseRoute();
  const edited = reorderWaypoint(original, 0, 1);
  assert.deepEqual(edited.waypoints.map(({ id }) => id), ['bravo', 'alpha']);
  assert.equal(reorderWaypoint(original, 1, 1), original);
  assert.deepEqual(original.waypoints.map(({ id }) => id), ['alpha', 'bravo']);
});

test('removeWaypoint permits returning to a direct route', () => {
  let route = baseRoute();
  route = removeWaypoint(route, 1);
  route = removeWaypoint(route, 0);
  assert.equal(route.waypoints.length, 0);
  assert.equal(getRoutePoints(route).length, 2);
});

test('edit operations reject out-of-range indexes and invalid new geometry', () => {
  const route = baseRoute();
  assert.throws(() => insertWaypoint(route, 3, { latitude: 1, longitude: 1 }), RangeError);
  assert.throws(() => moveWaypoint(route, -1, { latitude: 1, longitude: 1 }), RangeError);
  assert.throws(() => reorderWaypoint(route, 0, 2), RangeError);
  assert.throws(() => removeWaypoint(route, 2), RangeError);
  assert.throws(
    () => moveWaypoint(route, 0, { latitude: route.launch.latitude, longitude: route.launch.longitude }),
    /must be distinct/,
  );
});
