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

const flush = () => new Promise((resolve) => setImmediate(resolve));
const nadir = { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 };

test('events are contract events and percentageChanged defaults to Cesium 0.5', () => {
  const { camera } = setup();
  for (const name of ['changed', 'moveStart', 'moveEnd'])
    assert.ok(isEngineEvent(camera[name]), name);
  assert.equal(camera.percentageChanged, 0.5);
  camera.percentageChanged = 0.1;
  assert.equal(camera.percentageChanged, 0.1);
});

test('setView updates the pose at once and pushes the Navara pose in degrees', () => {
  const { camera, port } = setup();
  const destination = cartesian3.fromDegrees(-70, 45, 25000);
  camera.setView({
    destination,
    orientation: { heading: 1.2, pitch: -0.6, roll: 0.05 },
  });
  const pose = camera.pose();
  near(cartesian3.distance(pose.position, destination), 0, 1e-9, 'position');
  near(pose.heading, 1.2, 1e-12, 'heading');
  near(pose.pitch, -0.6, 1e-12, 'pitch');
  near(pose.roll, 0.05, 1e-12, 'roll');
  const pushed = port.applied.at(-1);
  near(pushed.lng, -70, 1e-9, 'lng');
  port.update();
  near(
    cartesian3.distance(port.drawn.direction, pose.direction),
    0,
    1e-12,
    'drawn direction',
  );
  near(cartesian3.distance(port.drawn.up, pose.up), 0, 1e-12, 'drawn up');
  assert.ok(port.frames > 0, 'no frame was requested');
});

test("Navara's clamped redraw of a pushed pose does not overwrite the exact pose", () => {
  const { camera, frame } = setup();
  camera.setView({ destination: cartesian3.fromDegrees(20, 10, 1e6) });
  frame();
  frame();
  near(camera.pose().pitch, -math.PI_OVER_TWO, 1e-12, 'pitch');
});

test('a camera Navara moves by itself (user input) becomes the pose', () => {
  const { camera, port, frame } = setup();
  camera.setView({ destination: cartesian3.fromDegrees(20, 10, 1e6) });
  frame();
  const moved = cartesian3.fromDegrees(21, 11, 9e5);
  port.drawn = { position: moved, ...orientationVectors(moved, 0.3, -1, 0) };
  frame();
  near(cartesian3.distance(camera.pose().position, moved), 0, 1e-9, 'adopted');
  near(camera.pose().heading, 0.3, 1e-9, 'heading');
});

test('a Navara camera not yet placed (at the Earth centre) is not the pose', () => {
  const port = createFakePort();
  const unplaced = {
    position: cartesian3.create(0, 0, 0),
    direction: cartesian3.create(0, 0, -1),
    up: cartesian3.create(0, 1, 0),
  };
  port.drawn = unplaced;
  const model = createCameraModel({ port, clock: createClock() });
  assert.ok(Number.isFinite(model.camera.height()), 'height at start');
  model.sync();
  assert.ok(Number.isFinite(model.camera.height()), 'height after a sync');
  assert.ok(model.camera.pose().cartographic, 'a place on the Earth');
});

test('missing angles default to heading 0, pitch −π/2 and roll 0', () => {
  const { camera } = setup();
  const destination = cartesian3.fromDegrees(40, 30, 20000);
  camera.setView({
    destination,
    orientation: { heading: 1, pitch: -0.3, roll: 0.2 },
  });
  camera.setView({ destination, orientation: { heading: 1 } });
  const pose = camera.pose();
  near(pose.heading, 1, 1e-12, 'heading');
  near(pose.pitch, -math.PI_OVER_TWO, 1e-12, 'pitch');
  assert.equal(pose.roll, 0);
});

test('setView takes direction/up and rectangle destinations', () => {
  const { camera } = setup();
  const destination = cartesian3.fromDegrees(5, 50, 3e5);
  const direction = cartesian3.normalize(
    cartesian3.negate(destination, cartesian3.create()),
    cartesian3.create(),
  );
  const up = cartesian3.normalize(
    cartesian3.cross(
      cartesian3.cross(direction, cartesian3.UNIT_Z, cartesian3.create()),
      direction,
      cartesian3.create(),
    ),
    cartesian3.create(),
  );
  camera.setView({ destination, orientation: { direction, up } });
  near(cartesian3.dot(camera.pose().direction, direction), 1, 1e-12, 'dir');
  camera.setView({
    destination: { west: 0.03, south: 0.85, east: 0.04, north: 0.86 },
  });
  const place = camera.pose().cartographic;
  near(place.longitude, 0.035, 1e-9, 'rectangle centre longitude');
  near(camera.pose().pitch, -math.PI_OVER_TWO, 1e-12, 'looks down');
});

test('flyTo with duration 0 lands and completes before it returns', () => {
  const { camera, port } = setup();
  const outcome = [];
  const destination = cartesian3.fromDegrees(-3.7, 40.4, 50000);
  camera.flyTo({
    destination,
    orientation: { heading: 0.5, pitch: -0.8, roll: 0 },
    duration: 0,
    complete: () => outcome.push('complete'),
    cancel: () => outcome.push('cancel'),
  });
  assert.deepEqual(outcome, ['complete']);
  assert.equal(camera.flightActive(), false);
  assert.equal(port.flights.length, 0);
  near(cartesian3.distance(camera.pose().position, destination), 0, 1e-9, 'p');
});

test('a timed flyTo flies with Navara in ms with the mapped easing and completes on arrival', async () => {
  const { camera, port, frame } = setup();
  const destination = cartesian3.fromDegrees(100, 0, 5e6);
  const outcome = [];
  camera.flyTo({
    destination,
    duration: 2.5,
    easing: 'sinusoidalInOut',
    endTransform: matrix4.IDENTITY,
    complete: () => outcome.push('complete'),
  });
  assert.equal(camera.flightActive(), true);
  const [flight] = port.flights;
  assert.equal(flight.options.duration, 2500);
  assert.equal(flight.options.easing, 'quadInOut');
  near(flight.pose.lng, 100, 1e-9, 'lng');
  near(flight.pose.pitch, -90, 1e-9, 'pitch');
  // Navara moves the camera during the flight; the pose follows it.
  const midway = cartesian3.fromDegrees(60, 5, 6e6);
  port.drawn = { position: midway, ...orientationVectors(midway, 0, -1.2, 0) };
  frame();
  near(cartesian3.distance(camera.pose().position, midway), 0, 1e-9, 'mid');
  flight.settle(true);
  await flush();
  assert.deepEqual(outcome, ['complete']);
  assert.equal(camera.flightActive(), false);
  near(cartesian3.distance(camera.pose().position, destination), 0, 1e-9, 'p');
});

test('easings map onto Navara presets and an omitted one stays Navara’s own', () => {
  const { camera, port } = setup();
  for (const easing of ['linear', 'cubicInOut', undefined])
    camera.flyTo({
      destination: cartesian3.fromDegrees(1, 2, 3e5),
      duration: 1,
      easing,
    });
  assert.deepEqual(
    port.flights.map((flight) => flight.options.easing),
    ['linear', 'cubicInOut', undefined],
  );
  camera.flyTo({ destination: cartesian3.fromDegrees(1, 2, 3e5) });
  assert.equal(port.flights.at(-1).options.duration, undefined);
});

test('an invalid flight pose does not suspend camera inputs', () => {
  const { camera, port } = setup();
  let suspensions = 0;
  port.suspendCameraInputs = () => {
    suspensions++;
    return () => {};
  };
  assert.throws(
    () =>
      camera.flyTo({
        destination: cartesian3.create(),
        orientation: {
          direction: cartesian3.create(0, 0, -1),
          up: cartesian3.create(0, 1, 0),
        },
        duration: 2,
      }),
    TypeError,
  );
  assert.equal(suspensions, 0);
  assert.equal(camera.flightActive(), false);
  assert.equal(port.flights.length, 0);
});

test('a synchronous flight failure releases the camera inputs', async (context) => {
  for (const method of ['flyTo', 'flyToSphere'])
    await context.test(method, () => {
      const { camera, port, model } = setup();
      const outcome = [];
      let suspensions = 0;
      port.suspendCameraInputs = () => {
        suspensions++;
        return () => suspensions--;
      };
      const error = new Error('Flight could not start');
      port.fly = () => {
        throw error;
      };
      const destination = cartesian3.fromDegrees(10, 45, 5000);
      const options = {
        duration: 2,
        complete: () => outcome.push('complete'),
        cancel: () => outcome.push('cancel'),
      };
      assert.throws(
        () =>
          method === 'flyTo'
            ? camera.flyTo({ destination, ...options })
            : camera.flyToSphere({ center: destination, radius: 100 }, options),
        (thrown) => thrown === error,
      );
      assert.equal(camera.flightActive(), false);
      assert.equal(suspensions, 0);
      assert.deepEqual(outcome, [], 'the exception alone reports it');
      camera.cancelFlight();
      model.destroy();
      assert.equal(suspensions, 0, 'the failed flight resumes only once');
      assert.deepEqual(outcome, []);
    });
});

test('cancelFlight stops Navara in place and calls cancel, never complete', async () => {
  const { camera, port } = setup();
  const outcome = [];
  camera.flyTo({
    destination: cartesian3.fromDegrees(100, 0, 5e6),
    duration: 5,
    complete: () => outcome.push('complete'),
    cancel: () => outcome.push('cancel'),
  });
  camera.cancelFlight();
  assert.equal(camera.flightActive(), false);
  assert.equal(port.stops, 1);
  port.flights[0].settle(false);
  await flush();
  assert.deepEqual(outcome, ['cancel']);
});

test('completeFlight lands at the destination and calls complete, as Cesium', async () => {
  const { camera, port } = setup();
  const outcome = [];
  let suspensions = 0;
  port.suspendCameraInputs = () => {
    suspensions++;
    return () => suspensions--;
  };
  const destination = cartesian3.fromDegrees(86.925, 27.988, 40000);
  camera.completeFlight();
  assert.equal(port.stops, 0, 'without a flight it does nothing');
  camera.flyTo({
    destination,
    orientation: { heading: 0.5, pitch: -0.8, roll: 0 },
    duration: 8,
    endTransform: matrix4.IDENTITY,
    complete: () => outcome.push('complete'),
    cancel: () => outcome.push('cancel'),
  });
  // Navara is midway when the flight is completed.
  const midway = cartesian3.fromDegrees(50, 15, 8e6);
  port.drawn = { position: midway, ...orientationVectors(midway, 0, -1, 0) };
  camera.completeFlight();
  assert.deepEqual(outcome, ['complete']);
  assert.equal(camera.flightActive(), false);
  assert.equal(suspensions, 0, 'the camera inputs are back');
  assert.equal(port.stops, 1);
  const pose = camera.pose();
  near(cartesian3.distance(pose.position, destination), 0, 1e-6, 'position');
  near(pose.heading, 0.5, 1e-9, 'heading');
  near(pose.pitch, -0.8, 1e-9, 'pitch');
  near(port.applied.at(-1).height, 40000, 1e-6, 'pushed to Navara');
  port.flights[0].settle(false);
  await flush();
  assert.deepEqual(outcome, ['complete']);
});

test('a newer flight cancels the previous one', async () => {
  const { camera, port } = setup();
  const outcome = [];
  camera.flyTo({
    destination: cartesian3.fromDegrees(100, 0, 5e6),
    duration: 5,
    complete: () => outcome.push('first complete'),
    cancel: () => outcome.push('first cancel'),
  });
  camera.flyTo({
    destination: cartesian3.fromDegrees(20, 10, 2e6),
    duration: 0,
    complete: () => outcome.push('second complete'),
  });
  port.flights[0].settle(false);
  await flush();
  assert.deepEqual(outcome, ['first cancel', 'second complete']);
});

test('a flight Navara interrupts on its own counts as cancelled', async () => {
  const { camera, port } = setup();
  const outcome = [];
  camera.flyTo({
    destination: cartesian3.fromDegrees(100, 0, 5e6),
    duration: 5,
    cancel: () => outcome.push('cancel'),
  });
  port.flights[0].settle(false);
  await flush();
  assert.deepEqual(outcome, ['cancel']);
  assert.equal(camera.flightActive(), false);
});

test('flyToSphere uses Cesium defaults and ends unlocked', () => {
  const { camera } = setup();
  const center = cartesian3.fromDegrees(2.35, 48.85, 100);
  camera.lookAt(center, { heading: 0, pitch: -1, range: 500 });
  let done = false;
  camera.flyToSphere(
    { center, radius: 0 },
    { duration: 0, complete: () => (done = true) },
  );
  assert.equal(done, true);
  near(cartesian3.distance(camera.pose().position, center), 100, 1e-6, 'r');
  assert.deepEqual(camera.transform(), [...matrix4.IDENTITY]);
});

test('lookAt locks the transform, aims at the target and release keeps the pose', () => {
  const { camera } = setup();
  const target = cartesian3.fromDegrees(-0.12, 51.5, 0);
  camera.lookAt(target, { heading: 0.4, pitch: -0.7, range: 2000 });
  const pose = camera.pose();
  near(cartesian3.distance(pose.position, target), 2000, 1e-6, 'range');
  const frame = geo.transforms.eastNorthUpToFixedFrame(
    target,
    geo.ellipsoid.WGS84,
  );
  camera
    .transform()
    .forEach((value, index) =>
      near(value, frame[index], 1e-9, `transform[${index}]`),
    );
  camera.release();
  assert.deepEqual(camera.transform(), [...matrix4.IDENTITY]);
  near(
    cartesian3.distance(camera.pose().position, pose.position),
    0,
    0,
    'release moved the camera',
  );
  camera.lookAtTransform(frame);
  near(
    cartesian3.distance(camera.pose().position, pose.position),
    0,
    0,
    'lookAtTransform without offset moved the camera',
  );
});

test('zoomIn and zoomOut move along the view direction', () => {
  const { camera } = setup();
  camera.setView({
    destination: cartesian3.fromDegrees(20, 10, 50000),
    orientation: { heading: 0.3, pitch: -0.9, roll: 0 },
  });
  const start = camera.pose();
  camera.zoomIn(2000);
  camera.zoomOut(500);
  const moved = cartesian3.subtract(
    camera.pose().position,
    start.position,
    cartesian3.create(),
  );
  near(cartesian3.dot(moved, start.direction), 1500, 1e-6, 'along');
  near(cartesian3.magnitude(moved), 1500, 1e-6, 'on the axis');
});

test('moveStart on the first moving frame, moveEnd after 500 ms still, changed past the threshold', () => {
  const { camera, frame, clock } = setup();
  const seen = [];
  for (const name of ['moveStart', 'moveEnd', 'changed'])
    camera[name].addEventListener(() => seen.push(name));
  frame();
  assert.deepEqual(seen, []);
  camera.setView({ destination: cartesian3.fromDegrees(60, -30, 2e6) });
  frame();
  assert.deepEqual(seen, ['moveStart', 'changed']);
  camera.setView({ destination: cartesian3.fromDegrees(60, -30, 2.01e6) });
  frame(300);
  assert.deepEqual(seen, ['moveStart', 'changed'], 'one movement');
  clock.advance(499);
  assert.ok(!seen.includes('moveEnd'));
  clock.advance(1);
  assert.deepEqual(seen, ['moveStart', 'changed', 'moveEnd']);
});

test('picks, projection and view rectangle come from the pose and canvas size', () => {
  const { camera, port, model } = setup();
  camera.setView({ destination: cartesian3.fromDegrees(20, 10, 1e6) });
  const centre = cartesian2.create(port.width / 2, port.height / 2);
  const hit = camera.pickEllipsoid(centre);
  const place = geo.cartographic.fromCartesian(hit, geo.ellipsoid.WGS84);
  near(math.toDegrees(place.latitude), 10, 0.01, 'latitude');
  const ray = camera.pickRay(centre);
  near(cartesian3.dot(ray.direction, camera.pose().direction), 1, 1e-12, 'ray');
  const back = model.worldToWindow(hit);
  near(back.x, centre.x, 1e-6, 'x');
  const rectangle = camera.viewRectangle();
  assert.ok(
    rectangle.west < math.toRadians(20) && math.toRadians(20) < rectangle.east,
  );
  near(
    camera.pose().fovy,
    2 * Math.atan(Math.tan(Math.PI / 6) / 1.6),
    1e-15,
    'fovy',
  );
});

test('destroy cancels a running flight and stops the moveEnd timer', () => {
  const { camera, model, clock, frame } = setup();
  const outcome = [];
  camera.setView({ destination: cartesian3.fromDegrees(1, 1, 1e6) });
  frame();
  camera.flyTo({
    destination: cartesian3.fromDegrees(100, 0, 5e6),
    duration: 5,
    cancel: () => outcome.push('cancel'),
  });
  model.destroy();
  assert.deepEqual(outcome, ['cancel']);
  assert.equal(clock.timers.length, 0);
});

test('rounding noise in the drawn camera is no movement, so moveEnd still fires', () => {
  const { camera, port, frame, clock } = setup();
  const moved = cartesian3.fromDegrees(21, 11, 9e5);
  const drawn = { position: moved, ...orientationVectors(moved, 0.3, -1, 0) };
  let ends = 0;
  camera.moveEnd.addEventListener(() => ends++);
  port.drawn = drawn;
  frame();
  for (let index = 0; index < 60; index++) {
    // Navara re-derives the vectors every frame: same pose, last-bit noise.
    const jitter = index % 2 ? 1e-13 : -1e-13;
    port.drawn = {
      position: moved,
      direction: cartesian3.create(
        drawn.direction.x + jitter,
        drawn.direction.y,
        drawn.direction.z - jitter,
      ),
      up: cartesian3.create(drawn.up.x, drawn.up.y + jitter, drawn.up.z),
    };
    frame(16);
  }
  assert.equal(clock.time >= 960, true);
  assert.equal(ends, 1, 'moveEnd did not fire while Navara redrew the pose');
});

test('livePosition is one engine-owned object holding the current position; height() reads it', () => {
  const { camera, port, frame } = setup();
  const live = camera.livePosition;
  const destination = cartesian3.fromDegrees(20, 10, 12345);
  camera.setView({ destination });
  assert.equal(camera.livePosition, live, 'not the same object');
  near(cartesian3.distance(live, destination), 0, 1e-9, 'follows setView');
  near(camera.height(), 12345, 1e-6, 'height');
  frame();
  const moved = cartesian3.fromDegrees(21, 11, 9e5);
  port.drawn = { position: moved, ...orientationVectors(moved, 0.3, -1, 0) };
  frame();
  near(
    cartesian3.distance(camera.livePosition, moved),
    0,
    1e-9,
    'follows Navara',
  );
  near(camera.height(), 9e5, 1e-6, 'height after a user move');
  const pose = camera.pose();
  assert.notEqual(pose.position, live, 'pose shares the live object');
});

test('commanded fires before each camera command and never for reads', () => {
  const { camera } = setup();
  let raised = 0;
  const remove = camera.commanded.addEventListener(() => raised++);
  assert.ok(isEngineEvent(camera.commanded));
  camera.pose();
  camera.height();
  camera.viewRectangle();
  assert.equal(raised, 0);
  const target = cartesian3.fromDegrees(10, 10, 0);
  camera.setView({ destination: cartesian3.fromDegrees(10, 10, 1e6) });
  camera.flyTo({
    destination: cartesian3.fromDegrees(11, 10, 1e6),
    duration: 0,
  });
  camera.flyToSphere({ center: target, radius: 10 }, { duration: 0 });
  camera.lookAt(target, { heading: 0, pitch: -1, range: 500 });
  camera.cancelFlight();
  assert.equal(raised, 5);
  camera.release();
  camera.zoomIn(10);
  assert.equal(raised, 5, 'release and zoom are not new owners');
  remove();
  camera.setView({ destination: cartesian3.fromDegrees(10, 10, 1e6) });
  assert.equal(raised, 5);
});

test('pose carries the view aspect ratio', () => {
  const { camera, port } = setup();
  const { width, height } = port.size();
  assert.equal(camera.pose().aspectRatio, width / height);
});

test('setView cancels a model flight before its promise settles', async () => {
  const { camera, port } = setup();
  const outcome = [];
  camera.flyTo({
    destination: cartesian3.fromDegrees(0, 0, 50000),
    duration: 2,
    cancel: () => outcome.push('cancel'),
    complete: () => outcome.push('complete'),
  });
  const destination = cartesian3.fromDegrees(0, 0, 200000);
  camera.setView({ destination });
  assert.equal(camera.flightActive(), false);
  assert.deepEqual(outcome, ['cancel']);
  port.flights[0].settle(true);
  await Promise.resolve();
  near(
    cartesian3.distance(camera.pose().position, destination),
    0,
    1e-6,
    'setView stays',
  );
});

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
