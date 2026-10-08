import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCameraFraming } from './cameraFraming.js';

/** Height (m) of a Cartesian above the WGS84 ellipsoid. */
const heightOf = (cartesian) =>
  Cesium.Cartographic.fromCartesian(cartesian).height;

/**
 * A camera with Cesium's flight bookkeeping: a new flight or `cancelFlight`
 * cancels the current one, `land()` completes it, `cancelled` counts stops.
 */
function flightCamera(flights) {
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
  };
  return camera;
}

/**
 * A viewer whose scene sample is `sampled` (e.g. −14,886 m before the tiles
 * under the photo load) and whose globe terrain is `globe`.
 */
function setup({ sampled, globe = null, altitude = 149 }) {
  const flights = [];
  const state = {
    services: {},
    street: {
      position: { lon: -97.7364, lat: 30.2672 },
      bearing: 105,
      altitude,
    },
    viewer: {
      scene: {
        sampleHeightSupported: true,
        sampleHeight: () => sampled,
        globe: { getHeight: () => globe },
      },
      camera: flightCamera(flights),
    },
  };
  return {
    framing: createCameraFraming({ state }),
    state,
    flights,
  };
}

test('framing a photo stands the sphere on a plausible scene sample', () => {
  const { framing, flights } = setup({ sampled: 121 });
  framing.frame(framing.begin());
  assert.equal(flights.length, 1);
  assert.ok(Math.abs(heightOf(flights[0].sphere.center) - 123) < 0.01);
});

test('a sample kilometres underground falls back to the globe, then the image altitude', () => {
  const globe = setup({ sampled: -14_886, globe: 117 });
  globe.framing.frame(globe.framing.begin());
  assert.ok(Math.abs(heightOf(globe.flights[0].sphere.center) - 119) < 0.01);
  const altitude = setup({
    sampled: -14_886,
    globe: undefined,
    altitude: 149,
  });
  altitude.framing.frame(altitude.framing.begin());
  assert.ok(Math.abs(heightOf(altitude.flights[0].sphere.center) - 151) < 0.01);
});

test('cancel stops the framing flight while it is still ours', () => {
  const { framing, state } = setup({ sampled: 121 });
  const { camera } = state.viewer;
  framing.frame(framing.begin());
  framing.cancel();
  assert.equal(camera.cancelled, 1, 'the flight toward the closed photo stops');
  framing.cancel();
  assert.equal(camera.cancelled, 1, 'and only once');

  // Re-framing (the next photo) supersedes the first flight, not the claim.
  framing.frame(framing.begin());
  framing.frame(framing.begin());
  framing.cancel();
  assert.equal(camera.cancelled, 2);
});

test('cancel leaves a landed flight and a newer navigation flight alone', () => {
  const { framing, state, flights } = setup({ sampled: 121 });
  const { camera } = state.viewer;
  framing.frame(framing.begin());
  camera.land();
  framing.cancel();
  assert.equal(camera.cancelled, 0, 'landed: nothing to stop');

  framing.frame(framing.begin());
  // A search result flies the globe elsewhere; Cesium cancels ours first.
  camera.flyToBoundingSphere(null, {});
  assert.equal(flights.length, 3);
  framing.cancel();
  assert.equal(camera.cancelled, 0, 'the newer flight keeps going');
});

/**
 * The application's camera authority: `begin` stamps a generation (or refuses
 * like the cockpit), `reassert` releases tracking (here, a tracked entity)
 * only while that generation is current.
 */
function navigationFor(state, { refuse = false } = {}) {
  let generation = 0;
  const stamp = () => ++generation;
  const nav = {
    begins: [],
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
    /** Another feature takes the camera. */
    handOff: () => stamp(),
  };
  return nav;
}

test('a photo claims the camera when it starts opening and frames once loaded, releasing tracking', () => {
  const { framing, state, flights } = setup({ sampled: 160 });
  state.viewer.trackedEntity = { id: 'aircraft' };
  const nav = navigationFor(state);
  framing.attachNavigation(nav);
  const ticket = framing.begin();
  assert.deepEqual(nav.begins, ['photo']);
  assert.ok(state.viewer.trackedEntity, 'nothing is released while it loads');
  framing.frame(ticket);
  assert.equal(state.viewer.trackedEntity, undefined);
  assert.equal(flights.length, 1);
});

test('a photo that finishes loading after newer navigation does not frame', () => {
  const { framing, state, flights } = setup({ sampled: 160 });
  const nav = navigationFor(state);
  framing.attachNavigation(nav);
  const ticket = framing.begin();
  // The user flies to Sacramento, and then tracks an aircraft, while it loads.
  nav.handOff();
  state.viewer.trackedEntity = { id: 'aircraft' };
  framing.frame(ticket);
  assert.equal(flights.length, 0, 'no flight back to the photo');
  assert.deepEqual(state.viewer.trackedEntity, { id: 'aircraft' });
});

test('a refused claim (cockpit) does not frame the photo', () => {
  const { framing, state, flights } = setup({ sampled: 160 });
  framing.attachNavigation(navigationFor(state, { refuse: true }));
  framing.frame(framing.begin());
  assert.equal(flights.length, 0);
});

test('a photo that loads after the navigation was detached does not frame', () => {
  const { framing, state, flights } = setup({ sampled: 160 });
  framing.attachNavigation(navigationFor(state));
  const ticket = framing.begin();
  framing.attachNavigation(null);
  assert.doesNotThrow(() => framing.frame(ticket));
  assert.equal(flights.length, 0);
});
