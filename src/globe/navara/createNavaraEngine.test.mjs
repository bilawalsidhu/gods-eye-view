import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { assertGlobeEngine } from '../contract.js';
import { cesiumFovy, orientationVectors } from './cameraMath.js';
import { createNavaraEngine } from './createNavaraEngine.js';

const { cartesian2, cartesian3, math } = geo;

// The parts of a Navara ThreeView the engine uses.
function fakeView() {
  const handlers = new Map();
  const canvas = new EventTarget();
  Object.assign(canvas, {
    clientWidth: 1280,
    clientHeight: 800,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    parentElement: { id: 'container' },
  });
  const position = cartesian3.fromDegrees(0, 0, 1e7);
  const { direction, up } = orientationVectors(position, 0, -math.PI_OVER_TWO, 0);
  // three's camera.matrixWorld: columns right, up, back (−direction), position.
  const right = cartesian3.cross(direction, up, cartesian3.create());
  const elements = [
    right.x, right.y, right.z, 0,
    up.x, up.y, up.z, 0,
    -direction.x, -direction.y, -direction.z, 0,
    position.x, position.y, position.z, 1,
  ];
  const view = {
    canvas,
    animation: false,
    calls: [],
    flights: [],
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
    },
    off(name, fn) {
      handlers.get(name)?.delete(fn);
    },
    emit(name, ...args) {
      for (const fn of [...(handlers.get(name) ?? [])]) fn(...args);
    },
    listenerCount: () =>
      [...handlers.values()].reduce((count, set) => count + set.size, 0),
    camera: {
      raw: { matrixWorld: { elements }, updateMatrixWorld() {} },
      fovs: [],
      set fov(value) {
        view.camera.fovs.push(value);
      },
      set options(value) {
        view.calls.push(['options', value]);
      },
    },
    setCamera(pose) {
      view.calls.push(['setCamera', pose]);
    },
    flyTo(pose, options) {
      return new Promise((resolve) => view.flights.push({ pose, options, resolve }));
    },
    forceUpdate() {
      view.calls.push(['forceUpdate']);
    },
    pickDepthPosition(x, y) {
      view.calls.push(['pickDepthPosition', x, y]);
      return x > 100 ? { x: 1, y: 2, z: 3, isVector3: true } : null;
    },
    sampleTerrainHeight: () => undefined,
    addSource: (desc) => ({ id: 's', desc, delete: () => true }),
    addLayer: (desc) => ({ id: 'l', desc, delete() {} }),
    attribution: { add() {}, remove() {} },
  };
  return view;
}

const hooks = {
  tileRoots: () => [],
  isIdle: () => true,
  retainTileGeometry() {},
};

const setup = () => {
  const view = fakeView();
  const engine = createNavaraEngine(view, { hooks });
  return { view, engine };
};

test('the engine has every contract capability and reports kind navara', () => {
  const { engine, view } = setup();
  assertGlobeEngine(engine);
  assert.equal(engine.kind, 'navara');
  assert.equal(engine.host.canvas, view.canvas);
  assert.deepEqual(engine.host.size(), { width: 1280, height: 800 });
});

test("Navara's frame events drive the contract frames in order with timestamps", () => {
  const { engine, view } = setup();
  const order = [];
  for (const name of ['preUpdate', 'preRender', 'postRender'])
    engine.frames[name].addEventListener((time) => order.push([name, time]));
  view.emit('preUpdate', 1);
  view.emit('postUpdate', 1);
  view.emit('preRender', 2);
  view.emit('postRender', 3);
  assert.deepEqual(order, [
    ['preUpdate', 1],
    ['preRender', 2],
    ['postRender', 3],
  ]);
});

test('render requests are forceUpdate and continuous mode is Navara animation', () => {
  const { engine, view } = setup();
  engine.render.request();
  assert.deepEqual(view.calls.at(-1), ['forceUpdate']);
  engine.render.request('world-overlay');
  assert.deepEqual(view.calls.at(-1), ['forceUpdate'], 'the reason is ignored');
  engine.render.setContinuous(true);
  assert.equal(view.animation, true);
  assert.equal(engine.render.isContinuous(), true);
  engine.render.setContinuous(false);
  assert.equal(view.animation, false);
});

test("the camera starts from Navara's drawn camera and pushes poses with setCamera", () => {
  const { engine, view } = setup();
  near(engine.camera.pose().cartographic.height, 1e7, 1e-3, 'height');
  engine.camera.setView({ destination: cartesian3.fromDegrees(20, 10, 1e6) });
  const [, pose] = view.calls.findLast(([name]) => name === 'setCamera');
  near(pose.lng, 20, 1e-9, 'lng');
  near(pose.pitch, -90, 1e-9, 'pitch');
});

test("Navara's fov follows Cesium's vertical fov, also after a resize", () => {
  const { view, engine } = setup();
  near(view.camera.fovs.at(-1), math.toDegrees(cesiumFovy(1280, 800)), 1e-12, 'fov');
  view.canvas.clientWidth = 600;
  view.canvas.clientHeight = 900;
  view.emit('resize', 600, 900);
  near(view.camera.fovs.at(-1), 60, 1e-12, 'portrait fov');
  near(engine.camera.pose().fovy, Math.PI / 3, 1e-15, 'pose fovy');
});

test('cancelFlight stops Navara with an empty setCamera; user input cancels a flight', () => {
  const { engine, view } = setup();
  const outcome = [];
  engine.camera.flyTo({
    destination: cartesian3.fromDegrees(100, 0, 5e6),
    duration: 5,
    cancel: () => outcome.push('cancel'),
  });
  assert.equal(view.flights[0].options.duration, 5000);
  engine.camera.cancelFlight();
  assert.deepEqual(view.calls.at(-1), ['setCamera', {}]);
  engine.camera.flyTo({
    destination: cartesian3.fromDegrees(100, 0, 5e6),
    duration: 5,
    cancel: () => outcome.push('input'),
  });
  view.canvas.dispatchEvent(new Event('wheel'));
  assert.deepEqual(outcome, ['cancel', 'input']);
  assert.equal(engine.camera.flightActive(), false);
});

test('pickPosition reads Navara depth at client coordinates; pick finds no tiles', () => {
  const { engine, view } = setup();
  const hit = engine.picker.pickPosition(cartesian2.create(200, 30));
  assert.deepEqual(view.calls.at(-1), ['pickDepthPosition', 210, 50]);
  assert.deepEqual([hit.x, hit.y, hit.z], [1, 2, 3]);
  assert.equal(hit.isVector3, undefined, 'a three Vector3 leaked');
  assert.equal(engine.picker.pickPosition(cartesian2.create(1, 1)), undefined);
  assert.equal(engine.picker.pickPositionSupported, true);
  assert.equal(engine.picker.pick(cartesian2.create(1, 1)), undefined);
  assert.deepEqual(engine.picker.drillPick(cartesian2.create(1, 1), 3), []);
});

test('the projector agrees with the camera', () => {
  const { engine } = setup();
  const pose = engine.camera.pose();
  const ahead = cartesian3.add(
    pose.position,
    cartesian3.multiplyByScalar(pose.direction, 1000, cartesian3.create()),
    cartesian3.create(),
  );
  const window = engine.projector.worldToWindow(ahead);
  near(window.x, 640, 1e-6, 'x');
  near(window.y, 400, 1e-6, 'y');
  assert.equal(engine.projector.horizonVisible(cartesian3.fromDegrees(0, 0)), true);
});

test('destroy removes its Navara listeners, keeps the view and is idempotent', () => {
  const { engine, view } = setup();
  engine.frames.postRender.addEventListener(() => {});
  engine.input.on('click', () => {});
  engine.destroy();
  engine.destroy();
  assert.equal(view.listenerCount(), 0);
});

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} is not within ${tolerance} of ${expected}`,
  );
}

test('isDestroyed follows destroy', () => {
  const { engine } = setup();
  assert.equal(engine.isDestroyed(), false);
  engine.destroy();
  assert.equal(engine.isDestroyed(), true);
});

test('pickGlobe meets the terrain along the pick ray, or the ellipsoid', () => {
  const { engine, view } = setup();
  const centre = cartesian2.create(640, 400);
  const bare = engine.picker.pickGlobe(centre);
  const ellipsoid = engine.camera.pickEllipsoid(centre);
  near(cartesian3.distance(bare, ellipsoid), 0, 1e-6, 'no terrain: ellipsoid');
  view.sampleTerrainHeight = () => 2000;
  const raised = engine.picker.pickGlobe(centre);
  const place = geo.cartographic.fromCartesian(raised);
  near(place.height, 2000, 0.5, 'terrain height (m)');
  near(math.toDegrees(place.longitude), 0, 1e-6, 'longitude');
  assert.equal(engine.picker.pickGlobe(cartesian2.create(640, -1e7)), undefined);
});

test('a user gesture cancels a flight without raising camera.commanded', () => {
  const { engine, view } = setup();
  const outcome = [];
  let commanded = 0;
  engine.camera.flyTo({
    destination: cartesian3.fromDegrees(10, 10, 1e6),
    duration: 5,
    cancel: () => outcome.push('cancel'),
  });
  engine.camera.commanded.addEventListener(() => commanded++);
  view.canvas.dispatchEvent(new Event('pointerdown'));
  view.canvas.dispatchEvent(new Event('wheel'));
  assert.deepEqual(outcome, ['cancel']);
  assert.equal(engine.camera.flightActive(), false);
  assert.equal(commanded, 0, 'a gesture is the user, not a new camera owner');
});

// --- The ground floor (groundFloor.js) on the engine's frames ---------------

const heightOf = (engine) => engine.camera.pose().cartographic.height;

test('a free camera below the ground is lifted on preRender, without camera.commanded', () => {
  const { engine, view } = setup();
  view.sampleTerrainHeight = () => 100;
  engine.camera.setView({
    destination: cartesian3.fromDegrees(2.35, 48.85, 40),
    orientation: { heading: 0.5, pitch: -0.3, roll: 0 },
  });
  let commanded = 0;
  engine.camera.commanded.addEventListener(() => commanded++);
  const before = engine.camera.pose();
  view.emit('preRender', 1);
  near(heightOf(engine), 130, 1e-6, 'lifted to ground + 30 m');
  const after = engine.camera.pose();
  near(after.heading, before.heading, 1e-7, 'heading kept');
  near(after.pitch, before.pitch, 1e-7, 'pitch kept');
  assert.equal(commanded, 0);
  const [, pose] = view.calls.findLast(([name]) => name === 'setCamera');
  near(pose.height, 130, 1e-3, 'drawn lifted');
  // Navara's own wheel clamp follows the ground.
  const [, options] = view.calls.findLast(([name]) => name === 'options');
  const radius = cartesian3.magnitude(cartesian3.fromDegrees(2.35, 48.85, 100));
  near(options.minimumZoomDistance, radius + 30, 1e-6, 'clamp');
  engine.destroy();
});

test('the floor does not fight flights or a lookAt target', () => {
  const { engine, view } = setup();
  view.sampleTerrainHeight = () => 100;
  engine.camera.setView({
    destination: cartesian3.fromDegrees(2.35, 48.85, 500),
  });
  engine.camera.flyTo({
    destination: cartesian3.fromDegrees(2.35, 48.85, 50),
    duration: 3,
  });
  const calls = view.calls.length;
  view.emit('preRender', 1);
  assert.equal(
    view.calls.slice(calls).some(([name]) => name === 'setCamera'),
    false,
    'no lift during a flight',
  );
  engine.camera.cancelFlight();
  // An orbit-style lookAt from below the floor stays where it was put.
  engine.camera.lookAt(cartesian3.fromDegrees(2.35, 48.85, 0), {
    heading: 0,
    pitch: -0.1,
    range: 50,
  });
  const held = heightOf(engine);
  view.emit('preRender', 2);
  near(heightOf(engine), held, 1e-9, 'lookAt kept');
  engine.camera.release();
  view.emit('preRender', 3);
  near(heightOf(engine), 130, 1e-6, 'lifted once released');
  engine.destroy();
});
