import assert from 'node:assert/strict';
import test from 'node:test';
import * as geo from '../../geo/index.js';
import { createFakeEngine } from './fakeEngine.js';

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message ?? 'value'}: ${actual} is not within ${tolerance} of ${expected}`,
  );

test('the fake pose is controllable and returned as fresh geo values', () => {
  const engine = createFakeEngine({ width: 800, height: 600 });
  engine.fake.setPose({
    longitude: 0.5,
    latitude: 0.25,
    height: 2000,
    heading: 1,
    pitch: -0.4,
  });
  const pose = engine.camera.pose();
  close(pose.cartographic.longitude, 0.5, 1e-12, 'longitude');
  close(pose.cartographic.latitude, 0.25, 1e-12, 'latitude');
  close(pose.cartographic.height, 2000, 1e-6, 'height');
  close(pose.heading, 1, 1e-9, 'heading');
  close(pose.pitch, -0.4, 1e-9, 'pitch');
  close(pose.roll, 0, 1e-9, 'roll');
  pose.position.x = 0;
  assert.notEqual(engine.camera.pose().position.x, 0);
  assert.deepEqual(engine.host.size(), { width: 800, height: 600 });
  engine.fake.setSize(320, 200);
  assert.deepEqual(engine.host.size(), { width: 320, height: 200 });
});

test('the fake records contract calls for shell-module tests', () => {
  const engine = createFakeEngine();
  const destination = geo.cartesian3.fromDegrees(10, 20, 3000);
  engine.camera.setView({ destination });
  engine.camera.flyTo({ destination, duration: 2 });
  engine.camera.cancelFlight();
  engine.render.request();
  engine.render.request();
  assert.deepEqual(
    engine.fake.calls.map((call) => call.method),
    [
      'camera.setView',
      'camera.flyTo',
      'camera.cancelFlight',
      'render.request',
      'render.request',
    ],
  );
  assert.equal(engine.fake.callsOf('camera.flyTo')[0].args[0].duration, 2);
  assert.equal(engine.fake.renderRequests, 2);
  engine.fake.resetCalls();
  assert.deepEqual(engine.fake.calls, []);
  assert.equal(engine.fake.renderRequests, 0);
});

test('fake flights advance with frames and finish or cancel exactly once', () => {
  const engine = createFakeEngine();
  const destination = geo.cartesian3.fromDegrees(30, 40, 5000);
  const outcomes = [];
  engine.camera.flyTo({
    destination,
    duration: 1,
    complete: () => outcomes.push('complete'),
    cancel: () => outcomes.push('cancel'),
  });
  assert.equal(engine.camera.flightActive(), true);
  engine.fake.frames(30, 16);
  assert.deepEqual(outcomes, []);
  engine.fake.frames(40, 16);
  assert.deepEqual(outcomes, ['complete']);
  assert.ok(
    geo.cartesian3.distance(engine.camera.pose().position, destination) < 1e-6,
  );
  engine.camera.cancelFlight();
  assert.deepEqual(outcomes, ['complete']);

  engine.camera.flyTo({
    destination: geo.cartesian3.fromDegrees(0, 0, 1e6),
    cancel: () => outcomes.push('cancel'),
  });
  engine.camera.flyTo({
    destination,
    duration: 0,
    complete: () => outcomes.push('second'),
  });
  // Duration 0 lands and completes before flyTo returns, as in Cesium.
  assert.deepEqual(outcomes, ['complete', 'cancel', 'second']);
  assert.equal(engine.camera.flightActive(), false);
});

test('fake events can be emitted by hand and frames fire in order', () => {
  const engine = createFakeEngine();
  const seen = [];
  engine.camera.changed.addEventListener((value) =>
    seen.push(['changed', value]),
  );
  engine.frames.preUpdate.addEventListener((time) =>
    seen.push(['preUpdate', time]),
  );
  engine.frames.preRender.addEventListener((time) =>
    seen.push(['preRender', time]),
  );
  engine.frames.postRender.addEventListener((time) =>
    seen.push(['postRender', time]),
  );
  engine.fake.emit('camera.changed', 0.7);
  engine.fake.frame(10);
  assert.deepEqual(seen, [
    ['changed', 0.7],
    ['preUpdate', 10],
    ['preRender', 10],
    ['postRender', 10],
  ]);
  assert.throws(() => engine.fake.emit('camera.nope'), /Unknown engine event/);
});

test('fake input dispatches to subscribers and off removes them', () => {
  const engine = createFakeEngine();
  const seen = [];
  const off = engine.input.on('click', (event) => seen.push(event.position));
  engine.fake.input('click', { position: geo.cartesian2.create(4, 5) });
  off();
  engine.fake.input('click', { position: geo.cartesian2.create(6, 7) });
  assert.deepEqual(seen, [geo.cartesian2.create(4, 5)]);
  assert.throws(() => engine.input.on('wheel', () => {}), /Unknown input type/);
  engine.input.setCameraInputs(false);
  assert.equal(engine.fake.cameraInputsEnabled, false);
});

test('pick, sampleHeight and worldToWindow results can be scripted', () => {
  const engine = createFakeEngine();
  const screen = geo.cartesian2.create(10, 10);
  assert.equal(engine.picker.pick(screen), undefined);
  engine.fake.script('pick', { id: 'aircraft', primitive: {} });
  assert.equal(engine.picker.pick(screen).id, 'aircraft');
  engine.fake.script('pick', (position) =>
    position.x > 5 ? { id: 'x' } : undefined,
  );
  assert.equal(engine.picker.pick(screen).id, 'x');
  engine.fake.script('sampleHeight', 123);
  assert.equal(
    engine.surface.sampleHeight(geo.cartographic.fromDegrees(0, 0)),
    123,
  );
  engine.fake.script('worldToWindow', geo.cartesian2.create(1, 2));
  const result = geo.cartesian2.create();
  assert.equal(
    engine.projector.worldToWindow(geo.cartesian3.UNIT_X, result),
    result,
  );
  assert.deepEqual(result, geo.cartesian2.create(1, 2));
  engine.fake.unscript('worldToWindow');
  const { position, direction } = engine.camera.pose();
  const behind = geo.cartesian3.subtract(
    position,
    geo.cartesian3.multiplyByScalar(direction, 1000, geo.cartesian3.create()),
    geo.cartesian3.create(),
  );
  assert.equal(engine.projector.worldToWindow(behind), undefined);
  assert.throws(
    () => engine.fake.script('teleport', 1),
    /Unknown scripted result/,
  );
});

test('fake credits, maps and destroy keep inspectable state', () => {
  const engine = createFakeEngine();
  const remove = engine.credits.addStatic('<b>OSM</b>', { onScreen: true });
  assert.deepEqual(engine.fake.credits, [
    { html: '<b>OSM</b>', onScreen: true },
  ]);
  remove();
  remove();
  assert.deepEqual(engine.fake.credits, []);
  engine.maps.setPhotorealTiles({ kind: 'google-3d' });
  assert.equal(engine.maps.photorealActive(), true);
  assert.deepEqual(engine.fake.maps.photoreal, { kind: 'google-3d' });
  engine.maps.setPhotorealTiles(null);
  assert.equal(engine.maps.photorealActive(), false);
  engine.destroy();
  assert.equal(engine.fake.destroyed, true);
});

test('the fake camera follows Cesium conventions for roll, angle ranges and zoom', () => {
  const engine = createFakeEngine();
  const destination = geo.cartesian3.fromDegrees(0, 0, 1000);
  engine.camera.setView({
    destination,
    orientation: { heading: 0, pitch: 0, roll: 0.3 },
  });
  const pose = engine.camera.pose();
  // Facing north at (0, 0), east is +Y: positive roll tilts up toward east.
  close(pose.up.y, Math.sin(0.3), 1e-9, 'up east component');
  close(pose.roll, 0.3, 1e-9, 'roll');
  engine.camera.setView({
    destination,
    orientation: { heading: -0.5, pitch: 0, roll: -0.2 },
  });
  const wrapped = engine.camera.pose();
  close(wrapped.heading, 2 * Math.PI - 0.5, 1e-9, 'heading in [0, 2π)');
  close(wrapped.roll, 2 * Math.PI - 0.2, 1e-9, 'roll in [0, 2π)');
  engine.camera.setView({
    destination,
    orientation: { heading: 0.4, pitch: -Math.PI / 2, roll: 0.3 },
  });
  assert.equal(engine.camera.pose().roll, 0);
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(0, 0, 5000),
  });
  const before = engine.camera.pose();
  engine.camera.zoomIn(1000);
  const after = engine.camera.pose();
  close(
    geo.cartesian3.distance(before.position, after.position),
    1000,
    1e-6,
    'zoomIn',
  );
  engine.camera.zoomOut(400);
  close(engine.camera.pose().cartographic.height, 5000 - 600, 1e-3, 'zoomOut');
});

test('fake lookAtTransform keeps the transform until release', () => {
  const engine = createFakeEngine();
  const target = geo.cartesian3.fromDegrees(10, 10, 0);
  const frame = geo.transforms.eastNorthUpToFixedFrame(target);
  engine.camera.lookAtTransform(frame, {
    heading: 0,
    pitch: -0.5,
    range: 1000,
  });
  assert.deepEqual(engine.camera.transform(), [...frame]);
  engine.camera.transform()[0] = 42;
  assert.notEqual(engine.camera.transform()[0], 42);
  engine.camera.release();
  assert.deepEqual(engine.camera.transform(), [...geo.matrix4.IDENTITY]);
  engine.camera.lookAt(target, { heading: 0, pitch: -0.5, range: 1000 });
  assert.deepEqual(engine.camera.transform(), [...frame]);
  assert.deepEqual(engine.fake.lookAtTarget(), target);
});

test('fake input honours modifiers like Cesium: unmodified listeners skip modified input', () => {
  const engine = createFakeEngine();
  const seen = [];
  engine.input.on('click', () => seen.push('plain'));
  engine.input.on('click', () => seen.push('ctrl'), { modifier: 'ctrl' });
  engine.fake.input('click', { position: geo.cartesian2.create(1, 1) });
  engine.fake.input('click', { position: geo.cartesian2.create(1, 1) }, 'ctrl');
  engine.fake.input(
    'click',
    { position: geo.cartesian2.create(1, 1) },
    'shift',
  );
  assert.deepEqual(seen, ['plain', 'ctrl']);
  assert.throws(
    () => engine.input.on('click', () => {}, { modifier: 'meta' }),
    /Unknown input modifier/,
  );
});

test('fake terrain height and clamp results default to the bare ellipsoid and can be scripted', () => {
  const engine = createFakeEngine();
  const place = geo.cartographic.fromDegrees(1, 2, 0);
  assert.equal(engine.surface.terrainHeight(place), 0);
  assert.equal(
    engine.surface.clampToHeight(geo.cartesian3.fromDegrees(1, 2, 50)),
    undefined,
  );
  engine.fake.script('terrainHeight', 12);
  engine.fake.script('clampToHeight', (position) => position);
  assert.equal(engine.surface.terrainHeight(place), 12);
  const position = geo.cartesian3.fromDegrees(1, 2, 50);
  assert.equal(engine.surface.clampToHeight(position), position);
  assert.equal(engine.surface.terrainHeightSupported, true);
  assert.equal(engine.surface.clampToHeightSupported, true);
});

test('fake flights honour endTransform when they land', () => {
  const engine = createFakeEngine();
  const target = geo.cartesian3.fromDegrees(10, 20, 0);
  engine.camera.lookAt(target, { heading: 0, pitch: -0.5, range: 1000 });
  engine.camera.flyTo({
    destination: geo.cartesian3.fromDegrees(10, 20, 5000),
    duration: 0.1,
    endTransform: geo.matrix4.IDENTITY,
  });
  assert.notDeepEqual(engine.camera.transform(), [...geo.matrix4.IDENTITY]);
  engine.fake.frames(10, 16);
  assert.deepEqual(engine.camera.transform(), [...geo.matrix4.IDENTITY]);
});

test('a fake rectangle destination looks down on the rectangle centre', () => {
  const engine = createFakeEngine();
  const rectangle = {
    west: geo.math.toRadians(2.2),
    south: geo.math.toRadians(48.8),
    east: geo.math.toRadians(2.5),
    north: geo.math.toRadians(48.9),
  };
  engine.camera.flyTo({ destination: rectangle, duration: 0 });
  const pose = engine.camera.pose();
  close(pose.pitch, -Math.PI / 2, 1e-9, 'pitch');
  close(pose.cartographic.longitude, geo.math.toRadians(2.35), 1e-9, 'lon');
  const { width, height } = engine.host.size();
  for (const [lon, lat] of [
    [rectangle.west, rectangle.south],
    [rectangle.east, rectangle.north],
  ]) {
    const corner = engine.projector.worldToWindow(
      geo.cartesian3.fromRadians(lon, lat, 0),
    );
    assert.ok(corner.x >= -1 && corner.x <= width + 1, `x ${corner.x}`);
    assert.ok(corner.y >= -1 && corner.y <= height + 1, `y ${corner.y}`);
  }
});

test('fake sphere range follows Cesium: 100 m only for radius 0, no floor otherwise', () => {
  const engine = createFakeEngine({ width: 1000, height: 500 });
  const center = geo.cartesian3.fromDegrees(0, 0, 0);
  engine.camera.flyToSphere({ center, radius: 10 }, { duration: 0 });
  const tanPhi = Math.tan(engine.camera.pose().fovy / 2);
  close(
    geo.cartesian3.distance(engine.camera.pose().position, center),
    Math.max(10 / (2 * tanPhi), 10 / tanPhi),
    1e-6,
    'range (m)',
  );
  engine.camera.flyToSphere({ center, radius: 0 }, { duration: 0 });
  close(
    geo.cartesian3.distance(engine.camera.pose().position, center),
    100,
    1e-6,
  );
});

test('fake drillPick records width and height; maps return promises', async () => {
  const engine = createFakeEngine();
  engine.picker.drillPick(geo.cartesian2.create(1, 2), 3, 4, 5);
  assert.deepEqual(
    engine.fake.callsOf('picker.drillPick')[0].args.slice(1),
    [3, 4, 5],
  );
  for (const call of [
    engine.maps.setBaseImagery({ kind: 'osm' }),
    engine.maps.setTerrain({ kind: 'ellipsoid' }),
    engine.maps.setPhotorealTiles(null),
  ]) {
    assert.ok(call instanceof Promise);
    await call;
  }
});
