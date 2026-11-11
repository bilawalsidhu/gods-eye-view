import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../geo/index.js';
import { assertGlobeEngine, engineCapabilities } from '../contract.js';
import { cesiumFovy, orientationVectors } from '../cameraMath.js';
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
  const { direction, up } = orientationVectors(
    position,
    0,
    -math.PI_OVER_TWO,
    0,
  );
  // three's camera.matrixWorld: columns right, up, back (−direction), position.
  const right = cartesian3.cross(direction, up, cartesian3.create());
  const elements = [
    right.x,
    right.y,
    right.z,
    0,
    up.x,
    up.y,
    up.z,
    0,
    -direction.x,
    -direction.y,
    -direction.z,
    0,
    position.x,
    position.y,
    position.z,
    1,
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
      return new Promise((resolve) =>
        view.flights.push({ pose, options, resolve }),
      );
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

// Primitive ports for tests of engine orchestration.
const STUB_MOVERS = Object.freeze({
  createSet() {
    throw new Error("Navara movers need the view's three runtime (movers/)");
  },
  list: () => [],
});
const STUB_LINES = Object.freeze({
  createSegments() {
    throw new Error("Navara lines need the view's three runtime (lines/)");
  },
  createLine() {
    throw new Error("Navara lines need the view's three runtime (lines/)");
  },
  list: () => [],
});
const STUB_MESHES = Object.freeze({
  createMesh() {
    throw new Error('Navara meshes need the view runtime');
  },
  list: () => [],
});
const STUB_GROUND = Object.freeze({
  createPulseField() {
    throw new Error('Navara ground needs the view runtime');
  },
  createSet() {
    throw new Error("Navara ground needs the view's three runtime (ground/)");
  },
  list: () => [],
});
const STUB_IMAGERY = Object.freeze({
  createLayer() {
    throw new Error("Navara imagery needs the view's three runtime (imagery/)");
  },
  list: () => [],
  setSplitPosition() {},
  splitPosition: () => 0.5,
  surface: () => 'globe',
});

const ports = {
  movers: { movers: STUB_MOVERS, destroy() {} },
  lines: { lines: STUB_LINES, destroy() {} },
  ground: { ground: STUB_GROUND, destroy() {} },
  imagery: () => ({ imagery: STUB_IMAGERY, destroy() {} }),
  meshes: () => ({ meshes: STUB_MESHES, destroy() {} }),
};

const setup = () => {
  const view = fakeView();
  const engine = createNavaraEngine(view, { ...ports, hooks });
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

test('the engine clock is the app clock, latched on the view preUpdate before frames', async () => {
  const { createAppClock } = await import('../../time/clock.js');
  let wall = 2_000_000;
  const appClock = createAppClock({ now: () => wall });
  const view = fakeView();
  const engine = createNavaraEngine(view, { ...ports, hooks, appClock });
  assert.equal(engine.clock.now(), 2_000_000);
  const seen = [];
  for (const name of ['preUpdate', 'preRender', 'postRender'])
    engine.frames[name].addEventListener(() =>
      seen.push([name, engine.clock.frameTime()]),
    );
  wall += 16;
  view.emit('preUpdate', 1);
  wall += 4;
  view.emit('preRender', 2);
  view.emit('postRender', 3);
  assert.deepEqual(seen, [
    ['preUpdate', 2_000_016],
    ['preRender', 2_000_016],
    ['postRender', 2_000_016],
  ]);
  assert.equal(engine.clock.now(), 2_000_020);
  engine.destroy();
  wall += 16;
  view.emit('preUpdate', 4);
  assert.equal(seen.length, 3, 'no frame after destroy');
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

test('setSharpen hands changed states to the sharpen port and draws a frame', () => {
  const view = fakeView();
  const shown = [];
  let destroyed = 0;
  const engine = createNavaraEngine(view, {
    ...ports,
    hooks,
    sharpen: {
      set: (state) => shown.push(state),
      destroy: () => destroyed++,
    },
  });
  assert.deepEqual(engine.render.sharpen(), { enabled: false, amount: 1 });
  engine.render.setSharpen({ amount: 1.7 });
  engine.render.setSharpen({ enabled: true });
  assert.deepEqual(view.calls.at(-1), ['forceUpdate']);
  const calls = view.calls.length;
  engine.render.setSharpen({ enabled: true, amount: 1.7 });
  assert.equal(view.calls.length, calls, 'an unchanged state draws nothing');
  assert.throws(() => engine.render.setSharpen({ amount: -1 }), TypeError);
  assert.deepEqual(shown, [
    { enabled: false, amount: 1.7 },
    { enabled: true, amount: 1.7 },
  ]);
  engine.destroy();
  engine.destroy();
  assert.equal(destroyed, 1);
});

test('without a sharpen port setSharpen keeps the state only', () => {
  const { engine } = setup();
  engine.render.setSharpen({ enabled: true, amount: 0.5 });
  assert.deepEqual(engine.render.sharpen(), { enabled: true, amount: 0.5 });
});

// A styles port (stylePass.js createStylesPort) on two styles.
function stylesPort() {
  const port = {
    shown: [],
    destroyed: 0,
    names: ['retro', 'noir'],
    uniformNames: (name) =>
      name === 'retro' ? ['pixelation', 'time'] : ['grainAmt'],
    defaults: (name) =>
      name === 'retro' ? { pixelation: 5, time: 0 } : { grainAmt: 0.5 },
    set: (name, state) => port.shown.push([name, state]),
    destroy: () => port.destroyed++,
  };
  return port;
}

test('setStyle hands changed style states to the styles port and draws a frame', () => {
  const view = fakeView();
  const port = stylesPort();
  const engine = createNavaraEngine(view, { ...ports, hooks, styles: port });
  assertGlobeEngine(engine);
  assert.equal(engineCapabilities(engine).visualStyles, true);
  assert.deepEqual(engine.render.visualStyles, ['retro', 'noir']);
  assert.deepEqual(engine.render.style('retro'), {
    intensity: 0,
    uniforms: { pixelation: 5, time: 0 },
  });
  engine.render.setStyle('retro', { intensity: 0.5 });
  assert.deepEqual(view.calls.at(-1), ['forceUpdate']);
  engine.render.setStyle('retro', { uniforms: { time: 2 } });
  const calls = view.calls.length;
  engine.render.setStyle('retro', { intensity: 0.5, uniforms: { time: 2 } });
  assert.equal(view.calls.length, calls, 'an unchanged state draws nothing');
  assert.throws(() => engine.render.setStyle('snow', {}), TypeError);
  assert.throws(
    () => engine.render.setStyle('noir', { uniforms: { time: 1 } }),
    TypeError,
  );
  assert.throws(
    () => engine.render.setStyle('noir', { intensity: 1.5 }),
    TypeError,
  );
  assert.deepEqual(port.shown, [
    ['retro', { intensity: 0.5, uniforms: { pixelation: 5, time: 0 } }],
    ['retro', { intensity: 0.5, uniforms: { pixelation: 5, time: 2 } }],
  ]);
  // The port gets its own copy.
  port.shown[1][1].uniforms.time = 99;
  assert.equal(engine.render.style('retro').uniforms.time, 2);
  engine.destroy();
  engine.render.setStyle('noir', { intensity: 1 });
  assert.equal(port.shown.length, 2, 'nothing reaches a destroyed port');
  engine.destroy();
  assert.equal(port.destroyed, 1);
});

test('setBloom hands changed states to the bloom port and draws a frame', () => {
  const view = fakeView();
  const shown = [];
  let destroyed = 0;
  const engine = createNavaraEngine(view, {
    ...ports,
    hooks,
    bloom: { set: (state) => shown.push(state), destroy: () => destroyed++ },
  });
  assertGlobeEngine(engine);
  assert.equal(engineCapabilities(engine).bloom, true);
  assert.deepEqual(engine.render.bloom(), { enabled: false, strength: 0 });
  engine.render.setBloom({ strength: 0.5 });
  engine.render.setBloom({ enabled: true });
  assert.deepEqual(view.calls.at(-1), ['forceUpdate']);
  const calls = view.calls.length;
  engine.render.setBloom({ enabled: true, strength: 0.5 });
  assert.equal(view.calls.length, calls, 'an unchanged state draws nothing');
  assert.throws(() => engine.render.setBloom({ strength: 3 }), TypeError);
  assert.deepEqual(shown, [
    { enabled: false, strength: 0.5 },
    { enabled: true, strength: 0.5 },
  ]);
  engine.destroy();
  engine.destroy();
  assert.equal(destroyed, 1);
});

test('setCloudCover hands changed covers to the clouds port and draws a frame', () => {
  const view = fakeView();
  const shown = [];
  let destroyed = 0;
  const engine = createNavaraEngine(view, {
    ...ports,
    hooks,
    clouds: { set: (state) => shown.push(state), destroy: () => destroyed++ },
  });
  assertGlobeEngine(engine);
  assert.equal(engineCapabilities(engine).cloudCover, true);
  assert.deepEqual(engine.render.cloudCover(), { coverage: null });
  engine.render.setCloudCover({ coverage: 0.6 });
  assert.deepEqual(view.calls.at(-1), ['forceUpdate']);
  const calls = view.calls.length;
  engine.render.setCloudCover({ coverage: 0.6 });
  assert.equal(view.calls.length, calls, 'an unchanged cover draws nothing');
  engine.render.setCloudCover({ coverage: null });
  assert.throws(() => engine.render.setCloudCover({ coverage: 7 }), TypeError);
  assert.deepEqual(shown, [{ coverage: 0.6 }, { coverage: null }]);
  engine.destroy();
  assert.equal(destroyed, 1);
});

test('setContactSonar hands changes to the sonar port, asking a frame only outside one', () => {
  const view = fakeView();
  const shown = [];
  let destroyed = 0;
  const engine = createNavaraEngine(view, {
    ...ports,
    hooks,
    sonar: { set: (state) => shown.push(state), destroy: () => destroyed++ },
  });
  assertGlobeEngine(engine);
  assert.equal(engineCapabilities(engine).contactSonar, true);
  assert.equal(engine.render.contactSonar().enabled, false);
  engine.render.setContactSonar({ enabled: true, active: true });
  assert.deepEqual(view.calls.at(-1), ['forceUpdate']);
  assert.equal(shown.length, 1);
  // Inside a drawn frame the change shows in that frame: no other frame.
  engine.frames.preRender.addEventListener(() =>
    engine.render.setContactSonar({ angleDeg: 45 }),
  );
  const calls = view.calls.length;
  view.emit('preRender', 1);
  view.emit('postRender', 2);
  assert.equal(shown.at(-1).angleDeg, 45);
  assert.equal(
    view.calls.slice(calls).filter(([name]) => name === 'forceUpdate').length,
    0,
  );
  assert.throws(
    () => engine.render.setContactSonar({ opacity: 120 }),
    TypeError,
  );
  engine.destroy();
  assert.equal(destroyed, 1);
});

test('without a styles port the engine has no visualStyles capability', () => {
  const { engine } = setup();
  assert.equal(engineCapabilities(engine).visualStyles, false);
  assert.equal(engineCapabilities(engine).bloom, false);
  assert.equal(engineCapabilities(engine).cloudCover, false);
  assert.equal(engineCapabilities(engine).contactSonar, false);
  assert.equal(engine.render.setStyle, undefined);
  assert.equal(engine.render.setBloom, undefined);
});

test("the camera starts from Navara's drawn camera and pushes poses with setCamera", () => {
  const { engine, view } = setup();
  near(engine.camera.pose().cartographic.height, 1e7, 1e-3, 'height');
  engine.camera.setView({ destination: cartesian3.fromDegrees(20, 10, 1e6) });
  const [, pose] = view.calls.findLast(([name]) => name === 'setCamera');
  near(pose.lng, 20, 1e-9, 'lng');
  const drawn = orientationVectors(
    cartesian3.fromDegrees(pose.lng, pose.lat, 0),
    math.toRadians(pose.heading),
    math.toRadians(pose.pitch),
    math.toRadians(pose.roll),
  );
  const desired = engine.camera.pose();
  near(
    cartesian3.distance(drawn.direction, desired.direction),
    0,
    1e-12,
    'world direction',
  );
  near(cartesian3.distance(drawn.up, desired.up), 0, 1e-12, 'world up');
});

test("Navara's fov follows Cesium's vertical fov, also after a resize", () => {
  const { view, engine } = setup();
  near(
    view.camera.fovs.at(-1),
    math.toDegrees(cesiumFovy(1280, 800)),
    1e-12,
    'fov',
  );
  view.canvas.clientWidth = 600;
  view.canvas.clientHeight = 900;
  view.emit('resize', 600, 900);
  near(view.camera.fovs.at(-1), 60, 1e-12, 'portrait fov');
  near(engine.camera.pose().fovy, Math.PI / 3, 1e-15, 'pose fovy');
});

test('contactSonarDiagnostics counts the movers on screen', () => {
  const view = fakeView();
  // The camera is 10 000 km over (0°, 0°), looking down.
  const places = [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0],
    [180, 0, 1],
  ];
  const positions = new Float64Array(places.length * 3);
  const colors = new Float32Array(places.length * 4).fill(1);
  const shows = new Uint8Array(places.length).fill(1);
  places.forEach(([lon, lat, show], index) => {
    const position = cartesian3.fromDegrees(lon, lat, 0);
    positions.set([position.x, position.y, position.z], index * 3);
    shows[index] = show;
  });
  colors[1 * 4 + 3] = 0;
  const store = { positions, colors, shows, count: places.length };
  const engine = createNavaraEngine(view, {
    ...ports,
    movers: { ...ports.movers, pickables: () => [{ store }] },
    hooks,
  });
  // Shown and opaque, in view: the first; the second is transparent, the
  // third hidden, the fourth behind the Earth.
  assert.deepEqual(engine.contactSonarDiagnostics(), {
    supported: true,
    contacts: 1,
  });
  engine.destroy();
});

test("maxTextureSize reads the canvas's WebGL limit once", () => {
  const view = fakeView();
  const asked = [];
  view.canvas.getContext = (type) => {
    asked.push(type);
    return type === 'webgl2'
      ? { MAX_TEXTURE_SIZE: 0x0d33, getParameter: () => 8192 }
      : null;
  };
  const engine = createNavaraEngine(view, { ...ports, hooks });
  assert.equal(engine.render.maxTextureSize(), 8192);
  assert.equal(engine.render.maxTextureSize(), 8192);
  assert.deepEqual(asked, ['webgl2']);
  engine.destroy();
});

test('a render requested while a frame draws asks for the next frame', async () => {
  const { engine, view } = setup();
  const requests = () =>
    view.calls.filter(([name]) => name === 'forceUpdate').length;
  // The wind's flow asks for its next frame from preRender.
  const off = engine.frames.preRender.addEventListener(() =>
    engine.render.request('wind'),
  );
  view.emit('preRender', 1);
  view.emit('postRender', 1);
  // Navara clears its request flag once the frame is drawn.
  const drawn = requests();
  await Promise.resolve();
  assert.equal(requests(), drawn + 1, 'requested again after the frame');
  off();
  view.emit('preRender', 2);
  view.emit('postRender', 2);
  const idle = requests();
  await Promise.resolve();
  assert.equal(requests(), idle, 'no request, no next frame');
  engine.destroy();
});

test('cancelFlight stops Navara with an empty setCamera; user input leaves a flight running', () => {
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
  assert.deepEqual(outcome, ['cancel']);
  assert.equal(engine.camera.flightActive(), true);
  engine.destroy();
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
  assert.equal(
    engine.projector.horizonVisible(cartesian3.fromDegrees(0, 0)),
    true,
  );
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
  assert.equal(
    engine.picker.pickGlobe(cartesian2.create(640, -1e7)),
    undefined,
  );
});

test('a user gesture leaves a flight running without raising camera.commanded', () => {
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
  assert.deepEqual(outcome, []);
  assert.equal(engine.camera.flightActive(), true);
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

test('the floor stands aside while the camera inputs are off (the cockpit drives it)', () => {
  const { engine, view } = setup();
  view.sampleTerrainHeight = () => 100;
  const resumeInputs = engine.input.suspendCameraInputs();
  engine.camera.setView({
    destination: cartesian3.fromDegrees(2.35, 48.85, 112),
  });
  view.emit('preRender', 1);
  near(heightOf(engine), 112, 1e-6, 'the cockpit eye 12 m up is kept');
  resumeInputs();
  view.emit('preRender', 2);
  near(heightOf(engine), 130, 1e-6, 'lifted once the inputs are back');
  engine.destroy();
});

test('ground picks use the visible surface and fall back to the globe', async () => {
  const { normalizeGroundItem } = await import('../ground.js');
  const view = fakeView();
  // Right after a click Navara's depth read answers with its near plane.
  view.pickDepthPosition = () => cartesian3.fromDegrees(10.5, 10, 45900);
  const options = { id: 'rooftop', kind: 'disc', pickable: true, order: 0 };
  const item = normalizeGroundItem(
    'disc',
    { center: [10, 10], radiusM: 100, fill: [1, 0, 0, 1], pickId: 'roof' },
    0,
  );
  const engine = createNavaraEngine(view, {
    ...ports,
    hooks,
    ground: {
      ...ports.ground,
      pickables: () => [{ options, items: [item], shown: true }],
    },
  });
  const at = { x: 640, y: 400 };
  let globe = cartesian3.fromDegrees(10, 10, 0);
  engine.picker.pickGlobe = () => globe;
  let tiles = null;
  engine.surface.raycast = () => (tiles ? { position: tiles } : undefined);
  assert.equal(engine.picker.pick(at)?.id, 'roof', 'the globe, not the depth');
  // Under 3D tiles a tilted view meets the roof before the terrain.
  engine.maps.photorealActive = () => true;
  globe = cartesian3.fromDegrees(10.01, 10, 0);
  tiles = cartesian3.fromDegrees(10, 10, 40);
  assert.equal(engine.picker.pick(at)?.id, 'roof', 'the tiles shown');
  tiles = null;
  assert.equal(engine.picker.pick(at), undefined, 'a tile miss: the globe');
  globe = cartesian3.fromDegrees(10, 10, 0);
  assert.equal(engine.picker.pick(at)?.id, 'roof');
  engine.destroy();
});

// Cesium's CameraFlightPath turns the camera inputs off for the flight, so a
// gesture never cancels it; layers/infrastructure suspends the inputs for the
// same reason ("Camera input would cancel the flight").
test('a wheel during a flight with the camera inputs suspended does not cancel it', async () => {
  const { engine, view } = setup();
  const outcome = [];
  const restore = engine.input.suspendCameraInputs();
  engine.camera.flyTo({
    destination: cartesian3.fromDegrees(100, 0, 5e6),
    duration: 1.5,
    complete: () => outcome.push('complete'),
    cancel: () => outcome.push('cancel'),
  });
  view.canvas.dispatchEvent(new Event('wheel'));
  view.canvas.dispatchEvent(new Event('pointerdown'));
  assert.deepEqual(outcome, [], 'the flight goes on');
  assert.equal(engine.camera.flightActive(), true);
  restore();
  assert.equal(
    engine.input.cameraInputsEnabled(),
    false,
    'the flight keeps its own suspension',
  );
  view.flights[0].resolve(true);
  await Promise.resolve();
  assert.deepEqual(outcome, ['complete']);
  assert.equal(engine.input.cameraInputsEnabled(), true);
  engine.destroy();
});

test('optical zoom reaches the drawn camera and survives a resize', () => {
  const { engine, view } = setup();
  engine.camera.setFovy(0.2);
  near(view.camera.fovs.at(-1), geo.math.toDegrees(0.2), 1e-12, 'drawn fovy');
  near(engine.camera.pose().fovy, 0.2, 1e-12, 'projector fovy');
  const fov = 2 * Math.atan(Math.tan(0.1) * engine.camera.pose().aspectRatio);
  view.canvas.clientWidth = 600;
  view.canvas.clientHeight = 900;
  view.emit('resize');
  near(view.camera.fovs.at(-1), geo.math.toDegrees(fov), 1e-12, 'resized fovy');
  near(engine.camera.pose().fovy, fov, 1e-12, 'resized projector');
  engine.destroy();
});
