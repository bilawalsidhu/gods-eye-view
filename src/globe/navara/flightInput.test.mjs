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
