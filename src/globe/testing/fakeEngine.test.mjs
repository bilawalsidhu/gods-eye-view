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
  const resume = engine.input.suspendCameraInputs();
  const inner = engine.input.suspendCameraInputs();
  assert.equal(engine.input.cameraInputsEnabled(), false);
  inner();
  resume();
  resume();
  assert.equal(engine.input.cameraInputsEnabled(), true);
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

test('fake host elements can be supplied', () => {
  const container = { id: 'globe' };
  const canvas = { id: 'canvas' };
  const engine = createFakeEngine({ container, canvas });
  assert.equal(engine.host.container, container);
  assert.equal(engine.host.canvas, canvas);
  assert.deepEqual(createFakeEngine().host.container, {
    kind: 'fake-container',
  });
});

test('fake isDestroyed, commanded and pickGlobe are inspectable', () => {
  const engine = createFakeEngine();
  let commanded = 0;
  engine.camera.commanded.addEventListener(() => commanded++);
  engine.fake.emit('camera.commanded');
  engine.camera.cancelFlight();
  assert.equal(commanded, 2);
  engine.fake.script('pickGlobe', { x: 1, y: 2, z: 3 });
  assert.deepEqual(engine.picker.pickGlobe({ x: 0, y: 0 }), {
    x: 1,
    y: 2,
    z: 3,
  });
  assert.equal(engine.fake.callsOf('picker.pickGlobe').length, 1);
  assert.equal(engine.isDestroyed(), false);
  engine.destroy();
  assert.equal(engine.isDestroyed(), true);
});

test('a fake engine can share an app clock', async () => {
  const { createAppClock } = await import('../../time/clock.js');
  let wall = 5000;
  const appClock = createAppClock({ now: () => wall });
  const engine = createFakeEngine({ appClock });
  assert.equal(engine.fake.appClock, appClock);
  wall = 6000;
  assert.equal(engine.clock.now(), 6000);
  engine.fake.frame();
  assert.equal(appClock.frameTime(), 6000);
});

test('fake movers keep their sets and instances for layer tests', () => {
  const engine = createFakeEngine();
  const set = engine.movers.createSet({
    id: 'flights',
    kind: 'point',
    capacity: 4,
    point: { sizePx: 6 },
  });
  set.set(0, { position: { x: 1, y: 2, z: 3 }, color: [1, 0, 0, 1] });
  set.setCount(1);
  assert.deepEqual(engine.movers.list(), [
    { id: 'flights', kind: 'point', count: 1, capacity: 4, shown: true },
  ]);
  const before = engine.fake.renderRequests;
  set.commit();
  assert.equal(engine.fake.renderRequests, before + 1);
  const stored = engine.fake.moverSet('flights');
  assert.equal(stored.commits, 1);
  assert.deepEqual([...stored.store.colors.subarray(0, 4)], [1, 0, 0, 1]);
  assert.throws(
    () =>
      engine.movers.createSet({
        id: 'flights',
        kind: 'point',
        capacity: 1,
        point: { sizePx: 1 },
      }),
    /already/,
  );
  set.destroy();
  assert.deepEqual(engine.movers.list(), []);
  assert.equal(engine.fake.moverSet('flights'), undefined);
});

test('fake lines keep their positions, colour, matrix and visibility', () => {
  const engine = createFakeEngine();
  const line = engine.lines.createLine({
    id: 'trail',
    widthPx: 2,
    color: [1, 0, 0, 1],
  });
  line.setPositions([
    { x: 1, y: 2, z: 3 },
    { x: 4, y: 5, z: 6 },
  ]);
  line.show(false);
  const stored = engine.fake.line('trail');
  assert.deepEqual([...stored.positions], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(stored.color, [1, 0, 0, 1]);
  assert.equal(stored.shown, false);
  assert.deepEqual(engine.lines.list(), [
    { id: 'trail', points: 2, shown: false },
  ]);
  line.destroy();
  assert.equal(engine.fake.line('trail'), undefined);
});
