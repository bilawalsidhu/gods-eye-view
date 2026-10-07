import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCameraFollow } from './cameraFollow.js';
import { FOLLOW_EYE_HEIGHT_M } from './policy.js';

/** Height (m) of a Cartesian above the WGS84 ellipsoid. */
const heightOf = (cartesian) =>
  Cesium.Cartographic.fromCartesian(cartesian).height;

/**
 * A camera with Cesium's flight bookkeeping: a new flight or `cancelFlight`
 * cancels the current one, `land()` completes it, `cancelled` counts stops.
 */
function flightCamera(flights, views) {
  let current = null;
  function stop() {
    const flight = current;
    current = null;
    flight?.options.cancel?.();
    return Boolean(flight);
  }
  const camera = {
    cancelled: 0,
    flyToBoundingSphere(sphere, options = {}) {
      stop();
      current = { sphere, options };
      flights.push(current);
    },
    cancelFlight() {
      if (stop()) camera.cancelled++;
    },
    land() {
      const flight = current;
      current = null;
      flight?.options.complete?.();
    },
    setView: (view) => views.push(view),
  };
  return camera;
}

/**
 * A viewer whose scene sample is `sampled` (e.g. −14,886 m before the tiles
 * under the photo load) and whose bare earth is `dem`.
 */
function setup({ sampled, dem = null, globe = null, altitude = 149 }) {
  const flights = [];
  const views = [];
  const state = {
    services: {},
    street: {
      position: { lon: -97.7364, lat: 30.2672 },
      bearing: 105,
      tilt: -10,
      altitude,
      follow: false,
      followAvailable: true,
    },
    viewer: {
      scene: {
        sampleHeightSupported: true,
        sampleHeight: () => sampled,
        globe: { getHeight: () => globe },
      },
      camera: flightCamera(flights, views),
    },
  };
  const parts = {
    groundCaster: dem === null ? null : { groundAt: () => dem, prepare() {} },
  };
  return {
    follow: createCameraFollow({ state, parts }),
    state,
    flights,
    views,
  };
}

test('framing a photo ignores a sample kilometres underground and uses bare earth', () => {
  const { follow, flights } = setup({ sampled: -14_886, dem: 117 });
  follow.lookAtPosition(follow.beginFraming());
  assert.equal(flights.length, 1);
  const centre = heightOf(flights[0].sphere.center);
  assert.ok(
    Math.abs(centre - 119) < 0.01,
    `centre at ${centre} m, not underground`,
  );
});

test('a plausible mesh sample near bare earth wins (a street, or a modest roof)', () => {
  const { follow, flights } = setup({ sampled: 121, dem: 117 });
  follow.lookAtPosition(follow.beginFraming());
  assert.ok(Math.abs(heightOf(flights[0].sphere.center) - 123) < 0.01);
});

test('without bare earth an absurd sample falls back to the image altitude, never below the surface range', () => {
  const { follow, flights } = setup({
    sampled: -14_886,
    dem: null,
    globe: undefined,
    altitude: 149,
  });
  follow.lookAtPosition(follow.beginFraming());
  assert.ok(Math.abs(heightOf(flights[0].sphere.center) - 151) < 0.01);
});

test('following stands the camera at eye height above the checked ground', () => {
  const { follow, state, views } = setup({ sampled: -14_886, dem: 117 });
  state.street.follow = true;
  follow.followCamera();
  assert.equal(views.length, 1);
  assert.ok(
    Math.abs(heightOf(views[0].destination) - (117 + FOLLOW_EYE_HEIGHT_M)) <
      0.01,
  );
});

test('cancelFraming stops the framing flight while it is still ours', () => {
  const { follow, state } = setup({ sampled: 121, dem: 117 });
  const { camera } = state.viewer;
  follow.lookAtPosition(follow.beginFraming());
  follow.cancelFraming();
  assert.equal(camera.cancelled, 1, 'the flight toward the closed photo stops');
  follow.cancelFraming();
  assert.equal(camera.cancelled, 1, 'and only once');

  // Re-framing (the next photo) supersedes the first flight, not the claim.
  follow.lookAtPosition(follow.beginFraming());
  follow.lookAtPosition(follow.beginFraming());
  follow.cancelFraming();
  assert.equal(camera.cancelled, 2);
});

test('cancelFraming leaves a landed flight and a newer navigation flight alone', () => {
  const { follow, state, flights } = setup({ sampled: 121, dem: 117 });
  const { camera } = state.viewer;
  follow.lookAtPosition(follow.beginFraming());
  camera.land();
  follow.cancelFraming();
  assert.equal(camera.cancelled, 0, 'landed: nothing to stop');

  follow.lookAtPosition(follow.beginFraming());
  // A search result flies the globe elsewhere; Cesium cancels ours first.
  camera.flyToBoundingSphere(null, {});
  assert.equal(flights.length, 3);
  follow.cancelFraming();
  assert.equal(camera.cancelled, 0, 'the newer flight keeps going');
});

test('turning FOLLOW on stops the framing flight so it cannot fight the follow view', () => {
  const { follow, state, views } = setup({ sampled: 121, dem: 117 });
  const { camera } = state.viewer;
  follow.lookAtPosition(follow.beginFraming());
  follow.setFollow(true);
  assert.equal(camera.cancelled, 1, 'the framing tween stops');
  assert.equal(views.length, 1, 'and the camera stands at the photo');
});

/**
 * The application's camera authority: `run` releases tracking (here, a tracked
 * entity) and stamps a handoff before the move, or refuses like the cockpit.
 */
function navigationFor(state, { refuse = false } = {}) {
  const listeners = new Set();
  let generation = 0;
  const stamp = () => {
    generation++;
    for (const listener of listeners) listener({ generation });
    return generation;
  };
  const nav = {
    runs: [],
    begins: [],
    run(noun, move) {
      nav.runs.push(noun);
      if (refuse) return false;
      const current = stamp();
      state.viewer.trackedEntity = undefined;
      return move(current);
    },
    /** Deferred: stamp now, release only on a successful reassert. */
    begin(noun) {
      nav.begins.push(noun);
      return refuse ? false : stamp();
    },
    reassert(ticket) {
      if (ticket !== generation) return false;
      state.viewer.trackedEntity = undefined;
      return true;
    },
    subscribeHandoff(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Another feature takes the camera. */
    handOff: () => stamp(),
    listeners,
  };
  return nav;
}

test('a photo claims the camera when it starts opening and frames once loaded, releasing tracking', () => {
  const { follow, state, flights } = setup({ sampled: 160 });
  state.viewer.trackedEntity = { id: 'aircraft' };
  const nav = navigationFor(state);
  follow.attachNavigation(nav);
  const ticket = follow.beginFraming();
  assert.deepEqual(nav.begins, ['photo']);
  assert.ok(state.viewer.trackedEntity, 'nothing is released while it loads');
  follow.lookAtPosition(ticket);
  assert.equal(state.viewer.trackedEntity, undefined);
  assert.equal(flights.length, 1);
});

test('a photo that finishes loading after newer navigation does not frame', () => {
  const { follow, state, flights } = setup({ sampled: 160 });
  const nav = navigationFor(state);
  follow.attachNavigation(nav);
  const ticket = follow.beginFraming();
  // The user flies to Sacramento, and then tracks an aircraft, while it loads.
  nav.handOff();
  state.viewer.trackedEntity = { id: 'aircraft' };
  follow.lookAtPosition(ticket);
  assert.equal(flights.length, 0, 'no flight back to the photo');
  assert.deepEqual(state.viewer.trackedEntity, { id: 'aircraft' });
});

test('a refused claim (cockpit) neither frames the photo nor turns FOLLOW on', () => {
  const { follow, state, flights, views } = setup({ sampled: 160 });
  follow.attachNavigation(navigationFor(state, { refuse: true }));
  follow.lookAtPosition(follow.beginFraming());
  follow.setFollow(true);
  assert.equal(flights.length, 0);
  assert.equal(views.length, 0);
  assert.equal(state.street.follow, false);
});

test('FOLLOW claims the camera once and ends when another feature takes it', () => {
  const { follow, state, views } = setup({ sampled: 160 });
  let notified = 0;
  state.notify = () => notified++;
  const nav = navigationFor(state);
  follow.attachNavigation(nav);
  follow.setFollow(true);
  assert.equal(state.street.follow, true, 'our own handoff keeps FOLLOW on');
  assert.deepEqual(nav.runs, ['photo']);
  follow.followCamera();
  assert.deepEqual(nav.runs, ['photo'], 'pose updates do not claim again');
  assert.equal(views.length, 2);
  nav.handOff();
  assert.equal(state.street.follow, false);
  assert.ok(notified >= 2);
  follow.followCamera();
  assert.equal(views.length, 2, 'the camera is no longer driven');
});

test('destroying the follow part stops listening for handoffs', () => {
  const { follow, state } = setup({ sampled: 160 });
  const nav = navigationFor(state);
  follow.attachNavigation(nav);
  assert.equal(nav.listeners.size, 1);
  follow.destroy();
  assert.equal(nav.listeners.size, 0);
});
