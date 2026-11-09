import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { isEngineEvent } from '../contract.js';
import { orientationVectors } from '../cameraMath.js';
import { createCameraModel } from './cameraModel.js';

const { cartesian2, cartesian3, math, matrix4 } = geo;
const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance} of ${expected}`,
  );

// A stand-in for Navara's camera: setCamera lands on the next update with
// Navara's ±89.99° pitch clamp; flights resolve when the test says so.
function createFakePort() {
  const port = {
    applied: [],
    flights: [],
    stops: 0,
    frames: 0,
    drawn: null,
    width: 1280,
    height: 800,
    apply(pose) {
      port.applied.push(pose);
    },
    read: () => port.drawn,
    fly(pose, options) {
      let settle;
      const promise = new Promise((resolve) => (settle = resolve));
      port.flights.push({ pose, options, settle });
      return promise;
    },
    stop() {
      port.stops++;
    },
    size: () => ({ width: port.width, height: port.height }),
    requestFrame() {
      port.frames++;
    },
    /** Navara's update: draw a newly applied pose (pitch clamped). */
    drawnCount: 0,
    update() {
      if (port.applied.length === port.drawnCount) return;
      port.drawnCount = port.applied.length;
      const pose = port.applied.at(-1);
      const pitch = Math.max(-89.99, Math.min(89.99, pose.pitch));
      const position = cartesian3.fromDegrees(pose.lng, pose.lat, pose.height);
      port.drawn = {
        position,
        ...orientationVectors(
          cartesian3.fromDegrees(pose.lng, pose.lat, 0),
          math.toRadians(pose.heading),
          math.toRadians(pitch),
          math.toRadians(pose.roll),
        ),
      };
    },
  };
  return port;
}

function createClock() {
  const clock = {
    time: 0,
    timers: [],
    now: () => clock.time,
    setTimeout(fn, ms) {
      const timer = { fn, at: clock.time + ms };
      clock.timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      clock.timers = clock.timers.filter((entry) => entry !== timer);
    },
    advance(ms) {
      clock.time += ms;
      for (const timer of [...clock.timers])
        if (timer.at <= clock.time) {
          clock.clearTimeout(timer);
          timer.fn();
        }
    },
  };
  return clock;
}

function setup() {
  const port = createFakePort();
  const clock = createClock();
  const model = createCameraModel({ port, clock });
  // One Navara frame: update, preRender sync, postRender events.
  const frame = (ms = 16) => {
    clock.advance(ms);
    port.update();
    model.sync();
    model.afterFrame();
  };
  return { port, clock, model, camera: model.camera, frame };
}

// Cesium's Camera._updateCameraChanged: direction angle / (fovy / 2), and
// heading or roll change / π, each against percentageChanged (0.5).
test('turning in place raises changed as Cesium does', () => {
  const { camera, frame } = setup();
  const destination = cartesian3.fromDegrees(10, 45, 5000);
  camera.setView({
    destination,
    orientation: { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 },
  });
  frame();
  frame();
  let changed = 0;
  camera.changed.addEventListener(() => changed++);
  // Tilt from straight down to 45° on the spot: 45° > half the fovy.
  camera.setView({
    destination,
    orientation: { heading: 0, pitch: -(Math.PI / 4), roll: 0 },
  });
  frame();
  assert.equal(changed, 1, 'a 45° tilt in place');
  // Heading +170° looking straight down (north-up reset): direction unchanged.
  camera.setView({
    destination,
    orientation: { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 },
  });
  frame();
  const before = changed;
  camera.setView({
    destination,
    orientation: {
      heading: math.toRadians(170),
      pitch: -math.PI_OVER_TWO,
      roll: 0,
    },
  });
  frame();
  assert.equal(changed, before + 1, 'a 170° heading turn in the nadir');
});
