import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { isEngineEvent } from '../contract.js';
import { createCesiumCamera } from './camera.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';
import { createCameraViewer } from './testing/cameraViewer.mjs';

const notCesium = (value, label) => {
  assert.ok(value != null, `${label} is missing`);
  for (const type of [
    Cesium.Cartesian2,
    Cesium.Cartesian3,
    Cesium.Cartographic,
    Cesium.Matrix4,
    Cesium.Rectangle,
    Cesium.Ray,
  ])
    assert.ok(!(value instanceof type), `${label} leaks a Cesium ${type.name}`);
};

function setup() {
  const viewer = createFakeViewer();
  const { camera, destroy } = createCesiumCamera(viewer);
  return { viewer, camera, destroy, cesium: viewer.camera };
}

test('pose returns fresh geo values and wraps 2π angles to 0', () => {
  const { camera, cesium } = setup();
  const pose = camera.pose();
  for (const name of ['position', 'cartographic', 'direction', 'up', 'right'])
    notCesium(pose[name], name);
  assert.deepEqual(
    [pose.position.x, pose.position.y, pose.position.z],
    [7e6, 1e5, 2e5],
  );
  assert.notEqual(pose.position, cesium.positionWC);
  const expected = geo.cartographic.fromCartesian(
    pose.position,
    geo.ellipsoid.WGS84,
  );
  assert.equal(pose.cartographic.longitude, expected.longitude);
  assert.equal(pose.cartographic.height, expected.height);
  assert.equal(pose.heading, 0);
  assert.equal(pose.roll, 0);
  assert.equal(pose.pitch, -Math.PI / 2);
  assert.equal(pose.fovy, cesium.frustum.fovy);
  assert.deepEqual([pose.right.x, pose.right.y, pose.right.z], [0, 1, 0]);
  cesium.heading = 1.25;
  cesium.roll = 6;
  assert.equal(camera.pose().heading, 1.25);
  assert.equal(camera.pose().roll, 6);
  pose.position.x = 0;
  assert.equal(cesium.positionWC.x, 7e6, 'pose values are copies');
});

test('setView converts the destination and passes the orientation through', () => {
  const { viewer, camera } = setup();
  const destination = geo.cartesian3.fromDegrees(10, 20, 3000);
  camera.setView({
    destination,
    orientation: { heading: 1, pitch: -0.5, roll: 0.1 },
  });
  const [options] = viewer.callsOf('camera.setView')[0].args;
  assert.ok(options.destination instanceof Cesium.Cartesian3);
  assert.equal(options.destination.x, destination.x);
  assert.deepEqual(options.orientation, { heading: 1, pitch: -0.5, roll: 0.1 });

  const direction = geo.cartesian3.create(-1, 0, 0);
  const up = geo.cartesian3.create(0, 0, 1);
  camera.setView({ destination, orientation: { direction, up } });
  const [vectors] = viewer.callsOf('camera.setView')[1].args;
  assert.ok(vectors.orientation.direction instanceof Cesium.Cartesian3);
  assert.ok(vectors.orientation.up instanceof Cesium.Cartesian3);

  camera.setView({ destination });
  const [bare] = viewer.callsOf('camera.setView')[2].args;
  assert.equal(bare.orientation, undefined, "Cesium's own defaults apply");
  assert.throws(() => camera.setView({}), TypeError);
});

test('flyTo maps easing, duration and callbacks and tracks the flight', () => {
  const { viewer, camera, cesium } = setup();
  const outcome = [];
  camera.flyTo({
    destination: geo.cartesian3.fromDegrees(0, 0, 1e6),
    orientation: { heading: 0.5, pitch: -0.8, roll: 0 },
    duration: 4,
    easing: 'linear',
    complete: () => outcome.push('complete'),
    cancel: () => outcome.push('cancel'),
  });
  const [options] = viewer.callsOf('camera.flyTo')[0].args;
  assert.ok(options.destination instanceof Cesium.Cartesian3);
  assert.equal(options.duration, 4);
  assert.equal(options.easingFunction, Cesium.EasingFunction.LINEAR_NONE);
  assert.deepEqual(options.orientation, { heading: 0.5, pitch: -0.8, roll: 0 });
  assert.equal(camera.flightActive(), true);
  cesium.completeFlight();
  assert.equal(camera.flightActive(), false);
  assert.deepEqual(outcome, ['complete']);

  camera.flyTo({
    destination: geo.cartesian3.fromDegrees(0, 0, 1e6),
    easing: 'sinusoidalInOut',
    cancel: () => outcome.push('cancel'),
  });
  assert.equal(
    viewer.callsOf('camera.flyTo')[1].args[0].easingFunction,
    Cesium.EasingFunction.SINUSOIDAL_IN_OUT,
  );
  camera.cancelFlight();
  assert.equal(camera.flightActive(), false);
  assert.deepEqual(outcome, ['complete', 'cancel']);
  assert.equal(viewer.callsOf('camera.cancelFlight').length, 1);
});

test('flightActive also reports a flight started straight on the Cesium camera', () => {
  const { viewer, camera, cesium } = setup();
  assert.equal(camera.flightActive(), false);
  // Cesium runs every camera flight as a scene tween, so a layer's own
  // viewer.camera.flyTo counts as much as the engine's.
  const layerFlight = {};
  viewer.scene.tweens.push(layerFlight);
  assert.equal(camera.flightActive(), true);
  viewer.scene.tweens.splice(viewer.scene.tweens.indexOf(layerFlight), 1);
  assert.equal(camera.flightActive(), false);
  camera.flyTo({ destination: geo.cartesian3.fromDegrees(0, 0, 1e6) });
  assert.equal(camera.flightActive(), true);
  cesium.completeFlight();
  assert.equal(camera.flightActive(), false);
});

test('completeFlight lands at the destination and calls complete only', () => {
  const { scene, engine } = createCameraViewer();
  // Cesium's own flight: a real tween collection under the real camera.
  scene.tweens = new Cesium.TweenCollection();
  scene.screenSpaceCameraController = { enableInputs: true };
  const outcome = [];
  const destination = geo.cartesian3.fromDegrees(86.925, 27.988, 40000);
  engine.camera.completeFlight();
  engine.camera.flyTo({
    destination,
    orientation: { heading: 0.5, pitch: -0.8, roll: 0 },
    duration: 8,
    complete: () => outcome.push('complete'),
    cancel: () => outcome.push('cancel'),
  });
  assert.equal(engine.camera.flightActive(), true);
  engine.camera.completeFlight();
  assert.deepEqual(outcome, ['complete']);
  assert.equal(engine.camera.flightActive(), false);
  assert.equal(scene.screenSpaceCameraController.enableInputs, true);
  const pose = engine.camera.pose();
  assert.ok(geo.cartesian3.distance(pose.position, destination) < 0.01);
  assert.ok(Math.abs(pose.heading - 0.5) < 1e-6);
  assert.ok(Math.abs(pose.pitch + 0.8) < 1e-6);
  engine.destroy();
});

test('setView with direction and up keeps the exact basis next to nadir', () => {
  const { camera, engine } = createCameraViewer();
  const unit = (x, y, z) =>
    Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(x, y, z),
      new Cesium.Cartesian3(),
    );
  for (const locked of [false, true]) {
    // Nearly straight down at 15° N with a 30° roll: inside the band where
    // Cesium's heading/pitch/roll conversion drops the roll.
    const destination = Cesium.Cartesian3.fromDegrees(0, 15, 18_000_000);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(destination);
    const toWorld = (local) =>
      Cesium.Matrix4.multiplyByPointAsVector(
        enu,
        local,
        new Cesium.Cartesian3(),
      );
    const direction = toWorld(unit(0.01, 0, -1));
    const level = toWorld(unit(1, 0, 0.01));
    const right = Cesium.Cartesian3.cross(
      direction,
      level,
      new Cesium.Cartesian3(),
    );
    const roll = Cesium.Quaternion.fromAxisAngle(
      direction,
      Cesium.Math.toRadians(30),
    );
    const up = Cesium.Matrix3.multiplyByVector(
      Cesium.Matrix3.fromQuaternion(roll),
      Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
    if (locked)
      camera.lookAtTransform(
        Cesium.Transforms.eastNorthUpToFixedFrame(
          Cesium.Cartesian3.fromDegrees(20, 10),
        ),
      );
    engine.camera.setView({
      destination: geo.cartesian3.clone(destination),
      orientation: {
        direction: geo.cartesian3.clone(direction),
        up: geo.cartesian3.clone(up),
      },
    });
    const close = (actual, expected, tolerance, label) =>
      assert.ok(
        Cesium.Cartesian3.distance(actual, expected) < tolerance,
        `${label}: ${Cesium.Cartesian3.distance(actual, expected)}`,
      );
    close(camera.positionWC, destination, 1e-6, 'position');
    close(camera.directionWC, direction, 1e-12, 'direction');
    close(camera.upWC, up, 1e-12, 'up');
    close(
      camera.rightWC,
      Cesium.Cartesian3.cross(direction, up, new Cesium.Cartesian3()),
      1e-12,
      'right',
    );
    assert.equal(
      Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY),
      !locked,
      'the reference frame is kept',
    );
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
});

test('flyTo with duration 0 completes before it returns and leaves no flight', () => {
  const { camera } = setup();
  let done = false;
  camera.flyTo({
    destination: geo.cartesian3.fromDegrees(0, 0, 1e6),
    duration: 0,
    complete: () => (done = true),
  });
  assert.equal(done, true);
  assert.equal(camera.flightActive(), false);
});

test('a newer flight cancels the previous one and stays active', () => {
  const { viewer, camera } = setup();
  const outcome = [];
  camera.flyTo({
    destination: geo.cartesian3.fromDegrees(0, 0, 1e6),
    duration: 5,
    cancel: () => outcome.push('first cancel'),
  });
  camera.flyTo({
    destination: geo.cartesian3.fromDegrees(1, 0, 1e6),
    duration: 5,
  });
  assert.deepEqual(outcome, ['first cancel']);
  assert.equal(camera.flightActive(), true);
  assert.equal(
    viewer.callsOf('camera.flyTo')[1].args[0].easingFunction,
    undefined,
    "without an easing Cesium's own flight easing applies",
  );
});

test('flyToSphere builds a BoundingSphere and an offset with Cesium defaults', () => {
  const { viewer, camera } = setup();
  const center = geo.cartesian3.fromDegrees(2.35, 48.85, 100);
  let done = false;
  camera.flyToSphere(
    { center, radius: 1000 },
    { duration: 0, complete: () => (done = true) },
  );
  assert.equal(done, true);
  assert.equal(camera.flightActive(), false);
  const [sphere, options] = viewer.callsOf('camera.flyToBoundingSphere')[0]
    .args;
  assert.ok(sphere instanceof Cesium.BoundingSphere);
  assert.equal(sphere.center.x, center.x);
  assert.equal(sphere.radius, 1000);
  assert.ok(options.offset instanceof Cesium.HeadingPitchRange);
  assert.equal(options.offset.heading, 0);
  assert.equal(options.offset.pitch, -Math.PI / 4);
  assert.equal(
    options.offset.range,
    0,
    "a missing range is left to Cesium's own fit and zoom-distance clamp",
  );
  assert.equal(options.duration, 0);
  assert.equal(options.easingFunction, undefined);

  camera.flyToSphere(
    { center, radius: 10 },
    {
      heading: 0.3,
      pitch: -0.5,
      range: 5000,
      duration: 2,
      easing: 'linear',
    },
  );
  const explicit = viewer.callsOf('camera.flyToBoundingSphere')[1].args[1];
  assert.equal(explicit.easingFunction, Cesium.EasingFunction.LINEAR_NONE);
  assert.deepEqual(
    [explicit.offset.heading, explicit.offset.pitch, explicit.offset.range],
    [0.3, -0.5, 5000],
  );
  assert.equal(camera.flightActive(), true);
});

test('lookAt, lookAtTransform, transform and release cross the boundary', () => {
  const { viewer, camera, cesium } = setup();
  const target = geo.cartesian3.fromDegrees(-0.12, 51.5, 0);
  camera.lookAt(target, { heading: 0.4, pitch: -0.7, range: 2000 });
  const [cesiumTarget, offset] = viewer.callsOf('camera.lookAt')[0].args;
  assert.ok(cesiumTarget instanceof Cesium.Cartesian3);
  assert.equal(cesiumTarget.y, target.y);
  assert.ok(offset instanceof Cesium.HeadingPitchRange);
  assert.deepEqual(
    [offset.heading, offset.pitch, offset.range],
    [0.4, -0.7, 2000],
  );

  const frame = geo.transforms.eastNorthUpToFixedFrame(
    target,
    geo.ellipsoid.WGS84,
  );
  camera.lookAtTransform(frame, { heading: 1, pitch: -1, range: 10 });
  let [matrix, hpr] = viewer.callsOf('camera.lookAtTransform')[0].args;
  assert.ok(matrix instanceof Cesium.Matrix4);
  assert.deepEqual(Cesium.Matrix4.toArray(matrix), [...frame]);
  assert.ok(hpr instanceof Cesium.HeadingPitchRange);

  camera.lookAtTransform(frame, geo.cartesian3.create(0, -1000, 1000));
  [matrix, hpr] = viewer.callsOf('camera.lookAtTransform')[1].args;
  assert.ok(hpr instanceof Cesium.Cartesian3);
  assert.deepEqual([hpr.x, hpr.y, hpr.z], [0, -1000, 1000]);

  camera.lookAtTransform(frame);
  assert.equal(viewer.callsOf('camera.lookAtTransform')[2].args.length, 1);

  const held = camera.transform();
  assert.ok(Array.isArray(held));
  notCesium(held, 'transform');
  assert.deepEqual(held, [...frame]);
  held[0] = 99;
  assert.notEqual(cesium.transform[0], 99, 'transform returns a copy');

  camera.release();
  const [identity] = viewer.callsOf('camera.lookAtTransform')[3].args;
  assert.equal(identity, Cesium.Matrix4.IDENTITY);
});

test('zoomIn and zoomOut default to Cesium amount', () => {
  const { viewer, camera } = setup();
  camera.zoomIn(2000);
  camera.zoomOut();
  assert.deepEqual(viewer.callsOf('camera.zoomIn')[0].args, [2000]);
  assert.deepEqual(viewer.callsOf('camera.zoomOut')[0].args, [100000]);
});

test('viewRectangle, pickEllipsoid and pickRay return geo values', () => {
  const { viewer, camera, cesium } = setup();
  const rectangle = camera.viewRectangle();
  notCesium(rectangle, 'viewRectangle');
  assert.deepEqual(rectangle, { west: 0.1, south: 0.2, east: 0.3, north: 0.4 });
  assert.equal(
    viewer.callsOf('camera.computeViewRectangle')[0].args[0],
    Cesium.Ellipsoid.WGS84,
  );
  cesium.computeViewRectangle = () => undefined;
  assert.equal(camera.viewRectangle(), undefined);

  const hit = camera.pickEllipsoid(geo.cartesian2.create(10, 20));
  notCesium(hit, 'pickEllipsoid');
  assert.equal(hit.x, 6378137);
  const [screen, ellipsoid] = viewer.callsOf('camera.pickEllipsoid')[0].args;
  assert.ok(screen instanceof Cesium.Cartesian2);
  assert.deepEqual([screen.x, screen.y], [10, 20]);
  assert.equal(ellipsoid, Cesium.Ellipsoid.WGS84);
  cesium.pickEllipsoid = () => undefined;
  assert.equal(camera.pickEllipsoid(geo.cartesian2.create(0, 0)), undefined);

  const ray = camera.pickRay(geo.cartesian2.create(5, 6));
  notCesium(ray.origin, 'pickRay origin');
  notCesium(ray.direction, 'pickRay direction');
  assert.equal(ray.origin.x, 7e6);
  assert.equal(ray.direction.x, -1);
  assert.ok(
    viewer.callsOf('camera.getPickRay')[0].args[0] instanceof Cesium.Cartesian2,
  );
});

test('camera events are bridged and percentageChanged reads through', () => {
  const { camera, cesium } = setup();
  for (const name of ['changed', 'moveStart', 'moveEnd']) {
    assert.ok(isEngineEvent(camera[name]), name);
    assert.equal(cesium[name].numberOfListeners, 0, `${name} subscribed early`);
  }
  const seen = [];
  const remove = camera.changed.addEventListener((amount) => seen.push(amount));
  cesium.changed.raiseEvent(0.3);
  cesium.moveEnd.raiseEvent();
  assert.deepEqual(seen, [0.3]);
  remove();
  assert.equal(cesium.changed.numberOfListeners, 0);
  assert.equal(camera.percentageChanged, 0.5);
  camera.percentageChanged = 0.1;
  assert.equal(cesium.percentageChanged, 0.1);
});

test('destroy cancels the engine flight and drops Cesium subscriptions', () => {
  const { camera, destroy, cesium } = setup();
  const outcome = [];
  camera.changed.addEventListener(() => {});
  camera.flyTo({
    destination: geo.cartesian3.fromDegrees(0, 0, 1e6),
    duration: 5,
    cancel: () => outcome.push('cancel'),
  });
  destroy();
  assert.deepEqual(outcome, ['cancel']);
  assert.equal(cesium.changed.numberOfListeners, 0);
});

test('flyTo passes endTransform as a Cesium Matrix4', () => {
  const { viewer, camera } = setup();
  camera.flyTo({
    destination: geo.cartesian3.fromDegrees(0, 0, 1e6),
    duration: 0,
    endTransform: geo.matrix4.IDENTITY,
  });
  const [options] = viewer.callsOf('camera.flyTo')[0].args;
  assert.ok(options.endTransform instanceof Cesium.Matrix4);
  assert.deepEqual(Cesium.Matrix4.toArray(options.endTransform), [
    ...geo.matrix4.IDENTITY,
  ]);
  camera.flyTo({ destination: geo.cartesian3.fromDegrees(0, 0, 1e6) });
  assert.equal(
    viewer.callsOf('camera.flyTo')[1].args[0].endTransform,
    undefined,
  );
});

test('rectangle destinations become a Cesium.Rectangle in flyTo and setView', () => {
  const { viewer, camera } = setup();
  const rectangle = { west: -0.2, south: 0.6, east: -0.1, north: 0.7 };
  camera.flyTo({ destination: rectangle, duration: 0 });
  camera.setView({ destination: rectangle });
  for (const name of ['camera.flyTo', 'camera.setView']) {
    const { destination } = viewer.callsOf(name)[0].args[0];
    assert.ok(destination instanceof Cesium.Rectangle, name);
    assert.deepEqual(
      [
        destination.west,
        destination.south,
        destination.east,
        destination.north,
      ],
      [-0.2, 0.6, -0.1, 0.7],
    );
  }
});

test('livePosition is the Cesium camera positionWC and height reads its cartographic', () => {
  const { camera, cesium } = setup();
  cesium.positionCartographic = new Cesium.Cartographic(0.1, 0.2, 1234.5);
  assert.equal(camera.livePosition, cesium.positionWC);
  assert.equal(camera.height(), 1234.5);
});

test('the camera is the viewer camera (Viewer.camera is scene.camera)', () => {
  const viewer = createFakeViewer();
  const own = { ...viewer.camera, positionWC: new Cesium.Cartesian3(1, 2, 3) };
  const { camera } = createCesiumCamera({ ...viewer, camera: own });
  assert.equal(camera.livePosition, own.positionWC);
});

test('pose carries the frustum aspect ratio', () => {
  const { camera, cesium } = setup();
  assert.equal(camera.pose().aspectRatio, cesium.frustum.aspectRatio);
});

test('commanded hooks the Cesium camera and tracking only while it has listeners', () => {
  const { viewer, camera, cesium, destroy } = setup();
  const names = [
    'flyTo',
    'flyToBoundingSphere',
    'setView',
    'lookAt',
    'cancelFlight',
  ];
  const originals = Object.fromEntries(
    names.map((name) => [name, cesium[name]]),
  );
  const own = Object.fromEntries(
    names.map((name) => [name, Object.getOwnPropertyDescriptor(cesium, name)]),
  );
  let raised = 0;
  const listener = () => raised++;
  const remove = camera.commanded.addEventListener(listener);
  for (const name of names)
    assert.notEqual(cesium[name], originals[name], name);
  // Direct calls on the viewer camera (layers, cockpit) announce themselves.
  cesium.setView({});
  assert.equal(raised, 1);
  cesium.cancelFlight();
  assert.equal(raised, 2);
  // So do engine commands, once per Cesium entry point they reach.
  camera.lookAt(geo.cartesian3.fromDegrees(0, 0, 0), {
    heading: 0,
    pitch: -1,
    range: 10,
  });
  assert.equal(raised, 3);
  assert.equal(viewer.callsOf('camera.lookAt').length, 1);
  // A new tracked entity takes the camera too.
  viewer.trackedEntityChanged.raiseEvent({ id: 'contact' });
  assert.equal(raised, 4);
  camera.release();
  assert.equal(raised, 4, 'release is not a new owner');
  remove();
  for (const name of names) {
    assert.equal(cesium[name], originals[name], `${name} restored`);
    assert.deepEqual(Object.getOwnPropertyDescriptor(cesium, name), own[name]);
  }
  assert.equal(viewer.trackedEntityChanged.numberOfListeners, 0);
  cesium.setView({});
  assert.equal(raised, 4);
  camera.commanded.addEventListener(listener);
  destroy();
  assert.equal(cesium.setView, originals.setView, 'destroy unhooks');
  assert.equal(viewer.trackedEntityChanged.numberOfListeners, 0);
});

test('commanded leaves a newer hook on the camera in place', () => {
  const { camera, cesium } = setup();
  const remove = camera.commanded.addEventListener(() => {});
  const newer = () => {};
  cesium.flyTo = newer;
  remove();
  assert.equal(cesium.flyTo, newer);
});

test('setView cancels a running flight before placing the camera', () => {
  const { camera, cesium } = setup();
  camera.flyTo({
    destination: geo.cartesian3.fromDegrees(0, 0, 50000),
    duration: 2,
  });
  const calls = [];
  cesium.cancelFlight = () => calls.push('cancel');
  cesium.setView = () => calls.push('place');
  camera.setView({ destination: geo.cartesian3.fromDegrees(0, 0, 200000) });
  assert.deepEqual(calls, ['cancel', 'place']);
});

test('setView without a flight places the camera only', () => {
  const { camera, cesium } = setup();
  const calls = [];
  cesium.cancelFlight = () => calls.push('cancel');
  cesium.setView = () => calls.push('place');
  camera.setView({ destination: geo.cartesian3.fromDegrees(0, 0, 200000) });
  assert.deepEqual(calls, ['place']);
});

test('setView ends the engine flight through its cancellation callback', () => {
  const { camera } = setup();
  const outcome = [];
  camera.flyTo({
    destination: geo.cartesian3.fromDegrees(0, 0, 50000),
    duration: 2,
    cancel: () => outcome.push('cancel'),
    complete: () => outcome.push('complete'),
  });
  camera.setView({ destination: geo.cartesian3.fromDegrees(0, 0, 200000) });
  assert.deepEqual(outcome, ['cancel']);
  assert.equal(camera.flightActive(), false);
});

test('completing a sphere flight fires only complete before its look-at', () => {
  const { scene, engine } = createCameraViewer();
  scene.tweens = new Cesium.TweenCollection();
  scene.screenSpaceCameraController = { enableInputs: true };
  const target = geo.cartesian3.fromDegrees(85.9, 27.9, 2000);
  const offset = { heading: 0.4, pitch: -0.6, range: 12000 };
  const outcome = [];
  engine.camera.flyToSphere(
    { center: target, radius: 80 },
    {
      ...offset,
      duration: 2.2,
      complete() {
        outcome.push('complete');
        engine.camera.lookAt(target, offset);
        engine.camera.release();
      },
      cancel: () => outcome.push('cancel'),
    },
  );
  engine.camera.completeFlight();
  engine.camera.completeFlight();
  assert.deepEqual(outcome, ['complete']);
  assert.equal(engine.camera.flightActive(), false);
  assert.ok(
    Math.abs(
      geo.cartesian3.distance(engine.camera.pose().position, target) -
        offset.range,
    ) < 0.01,
  );
  engine.destroy();
});

test('vertical field of view changes the real Cesium projection and restores it', () => {
  const { camera, engine } = createCameraViewer();
  const saved = camera.frustum.fovy;
  engine.camera.setFovy(0.2);
  assert.ok(Math.abs(camera.frustum.fovy - 0.2) < 1e-12);
  assert.ok(Math.abs(engine.camera.pose().fovy - 0.2) < 1e-12);
  engine.camera.setFovy(saved);
  assert.ok(Math.abs(camera.frustum.fovy - saved) < 1e-12);
  engine.destroy();
});
