import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inputFor } from './dispatcher.js';
import {
  FAKE_EVENT_TYPES,
  FakeScreenSpaceEventHandler as FakeHandler,
  fakeInput,
} from './testDoubles.mjs';
import { sensorPickPosition } from './sensorPick.js';
import { registerStyleStages } from '../styles/styleStages.js';
import { claimPointer, releasePointer } from '../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../data/pickRegistry.js';

const TYPES = FAKE_EVENT_TYPES;

function harness({ pick = () => undefined, drillPick = () => [] } = {}) {
  const calls = { pick: 0, drillPick: 0 };
  const stock = new FakeHandler();
  const stockClick = () => {};
  const stockDouble = () => {};
  stock.setInputAction(stockClick, TYPES.LEFT_CLICK);
  stock.setInputAction(stockDouble, TYPES.LEFT_DOUBLE_CLICK);
  let clock = 0;
  const viewer = {
    screenSpaceEventHandler: stock,
    camera: { pickEllipsoid: () => null },
    scene: {
      canvas: {},
      screenSpaceCameraController: { enableInputs: true },
      pick(...args) {
        calls.pick += 1;
        return pick(...args);
      },
      drillPick(...args) {
        calls.drillPick += 1;
        return drillPick(...args);
      },
    },
  };
  const { input, handler } = fakeInput(viewer, { now: () => clock });
  return {
    viewer,
    input,
    handler,
    stock,
    stockClick,
    stockDouble,
    calls,
    advance(ms) {
      clock += ms;
    },
    click(x = 10, y = 10) {
      handler.fire(TYPES.LEFT_DOWN, { position: { x, y } });
      handler.fire(TYPES.LEFT_UP, { position: { x, y } });
      handler.fire(TYPES.LEFT_CLICK, { position: { x, y } });
    },
  };
}

test('every subscriber reads one pick of the click', (t) => {
  registerPickOwner('test-owner', (id) => id === 'plane-1');
  t.after(() => unregisterPickOwner('test-owner'));
  const h = harness({ pick: () => ({ id: 'plane-1' }) });
  t.after(() => h.input.destroy());
  const seen = [];
  for (let i = 0; i < 5; i++)
    h.input.onClick((event) => seen.push([event.id, event.ownerId]));
  h.click();
  assert.equal(h.calls.pick, 1);
  assert.deepEqual(seen, Array(5).fill(['plane-1', 'test-owner']));
});

test('a click on nothing is picked once, however its hit is read', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  h.input.onClick((event) => [event.pick, event.hit, event.id, event.ownerId]);
  h.click();
  assert.equal(h.calls.pick, 1);
});

test('a click nobody reads is never picked', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  h.input.onClick(() => {});
  h.click();
  assert.equal(h.calls.pick, 0);
});

test('the gesture carries summed travel and press time', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  let gesture;
  h.input.onClick((event) => (gesture = event.gesture));
  h.handler.fire(TYPES.LEFT_DOWN, { position: { x: 0, y: 0 } });
  h.handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 4, y: 0 } });
  h.handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 0, y: 0 } });
  h.advance(250);
  h.handler.fire(TYPES.LEFT_UP, { position: { x: 0, y: 0 } });
  h.handler.fire(TYPES.LEFT_CLICK, { position: { x: 0, y: 0 } });
  assert.deepEqual(gesture, { travelPx: 8, durationMs: 250 });
});

test('a held pointer goes to its tool, not to ambient selection', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const lease = claimPointer('test-tool');
  t.after(() => releasePointer(lease));
  const order = [];
  h.input.onClick(() => order.push('ambient'));
  h.input.onPointer(
    'click',
    () => {
      order.push('tool');
      // Releasing mid-click must not hand THIS click to ambient selection.
      releasePointer(lease);
    },
    { lease },
  );
  h.click();
  assert.deepEqual(order, ['tool']);
  h.click();
  assert.deepEqual(order, ['tool', 'ambient']);
});

test('moves and releases reach ambient subscribers while a tool holds the pointer; presses do not', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const seen = [];
  h.input.onPointer('move', () => seen.push('move'));
  h.input.onPointer('down', () => seen.push('down'));
  h.input.onPointer('up', () => seen.push('up'));
  const lease = claimPointer('test-tool');
  t.after(() => releasePointer(lease));
  h.handler.fire(TYPES.LEFT_DOWN, { position: { x: 0, y: 0 } });
  h.handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 1, y: 0 } });
  h.handler.fire(TYPES.LEFT_UP, { position: { x: 1, y: 0 } });
  assert.deepEqual(seen, ['move', 'up']);
});

test('a stale lease gets nothing once its successor holds the pointer', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const first = claimPointer('test-tool');
  let staleRan = 0;
  h.input.onPointer('down', () => (staleRan += 1), { lease: first });
  releasePointer(first);
  const second = claimPointer('test-tool');
  t.after(() => releasePointer(second));
  h.click();
  assert.equal(staleRan, 0);
});

test('camera input returns only when the last hold releases', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const controller = h.viewer.scene.screenSpaceCameraController;
  const drag = h.input.suspendCamera('drag');
  const flight = h.input.suspendCamera('flight');
  assert.equal(controller.enableInputs, false);
  // The flight ends while the drag still holds the camera.
  flight();
  assert.equal(controller.enableInputs, false);
  flight();
  assert.equal(controller.enableInputs, false, 'a double release is a no-op');
  drag();
  assert.equal(controller.enableInputs, true);
});

test('a camera flight that ends does not give input back under a hold', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const controller = h.viewer.scene.screenSpaceCameraController;
  // Cesium's CameraFlightPath turns input off for the flight and back on
  // when it completes or is cancelled, whoever else holds the camera.
  controller.enableInputs = false;
  const drag = h.input.suspendCamera('drag');
  controller.enableInputs = true;
  assert.equal(controller.enableInputs, false, 'the drag still holds it');
  drag();
  assert.equal(controller.enableInputs, true);
  controller.enableInputs = false;
  assert.equal(controller.enableInputs, false, 'a flight still turns it off');
  controller.enableInputs = true;
});

test('a controller with its own enableInputs accessor keeps it', () => {
  const h = harness();
  h.input.destroy();
  const controller = h.viewer.scene.screenSpaceCameraController;
  let stored = true;
  const get = () => stored;
  const set = (value) => (stored = value);
  Object.defineProperty(controller, 'enableInputs', {
    configurable: true,
    enumerable: true,
    get,
    set,
  });
  const input = inputFor(h.viewer, {
    createHandler: () => new FakeHandler(),
    eventTypes: TYPES,
  });
  const hold = input.suspendCamera('drag');
  assert.equal(controller.enableInputs, false);
  controller.enableInputs = false;
  assert.equal(stored, false, 'writes reach the original setter');
  controller.enableInputs = true;
  hold();
  assert.equal(controller.enableInputs, true);
  input.destroy();
  const restored = Object.getOwnPropertyDescriptor(controller, 'enableInputs');
  assert.equal(restored.get, get);
  assert.equal(restored.set, set);
});

test('a controller whose enableInputs is inherited keeps its class accessor', () => {
  class Controller {
    constructor() {
      this.stored = false;
    }
    get enableInputs() {
      return this.stored;
    }
    set enableInputs(value) {
      this.stored = value;
    }
  }
  const controller = new Controller();
  const viewer = {
    scene: { canvas: {}, screenSpaceCameraController: controller },
  };
  const input = inputFor(viewer, {
    createHandler: () => new FakeHandler(),
    eventTypes: TYPES,
  });
  assert.equal(controller.enableInputs, false, 'the inherited getter is read');
  controller.enableInputs = true;
  assert.equal(controller.stored, true, 'and the inherited setter written');
  const hold = input.suspendCamera('drag');
  assert.equal(controller.enableInputs, false);
  hold();
  assert.equal(controller.enableInputs, true);
  input.destroy();
  assert.equal(
    Object.getOwnPropertyDescriptor(controller, 'enableInputs'),
    undefined,
    'nothing is left shadowing the class',
  );
});

test('a controller whose enableInputs cannot be owned still gets a dispatcher', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const controller = {};
    Object.defineProperty(controller, 'enableInputs', {
      configurable: false,
      get: () => true,
      set() {},
    });
    const handler = new FakeHandler();
    const viewer = {
      scene: { canvas: {}, screenSpaceCameraController: controller },
    };
    const input = inputFor(viewer, {
      createHandler: () => handler,
      eventTypes: TYPES,
    });
    const hold = input.suspendCamera('drag');
    hold();
    input.destroy();
    assert.equal(handler.destroyed, true);
  } finally {
    console.warn = warn;
  }
});

test('stock clicks come back by identity after the last hold', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const a = h.input.suppressStockClicks();
  const b = h.input.suppressStockClicks();
  assert.equal(h.stock.getInputAction(TYPES.LEFT_CLICK), undefined);
  a();
  assert.equal(h.stock.getInputAction(TYPES.LEFT_DOUBLE_CLICK), undefined);
  b();
  assert.equal(h.stock.getInputAction(TYPES.LEFT_CLICK), h.stockClick);
  assert.equal(h.stock.getInputAction(TYPES.LEFT_DOUBLE_CLICK), h.stockDouble);
});

test('drills of different depths on one click share a pass', (t) => {
  const hits = Array.from({ length: 20 }, (_, i) => ({ id: `hit-${i}` }));
  const h = harness({ drillPick: (_p, limit) => hits.slice(0, limit) });
  t.after(() => h.input.destroy());
  const lengths = [];
  h.input.onClick((event) => lengths.push(event.drill(12).length));
  h.input.onClick((event) => lengths.push(event.drill(8).length));
  h.input.onClick((event) => lengths.push(event.drill(16).length));
  h.click();
  assert.deepEqual(lengths, [12, 8, 16]);
  assert.equal(h.calls.drillPick, 1);
});

test('a touch tap’s contact search is the click’s own drill', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query) => ({ matches: query === '(pointer: coarse)' }),
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'matchMedia', previous);
    else delete globalThis.matchMedia;
  });
  registerPickOwner('test-owner', (id) => id === 'plane-1');
  t.after(() => unregisterPickOwner('test-owner'));
  const tile = { primitive: { isCesium3DTileset: true } };
  const h = harness({ pick: () => tile, drillPick: () => [{ id: 'plane-1' }] });
  t.after(() => h.input.destroy());
  const seen = [];
  h.input.onClick((event) => seen.push(event.id));
  h.input.onClick((event) => seen.push(event.drill(8, 14, 14).length));
  h.click();
  assert.deepEqual(seen, ['plane-1', 1]);
  assert.equal(h.calls.drillPick, 1);
});

test('a short drill answers deeper asks without another pass', (t) => {
  const h = harness({ drillPick: () => [{ id: 'only' }] });
  t.after(() => h.input.destroy());
  h.input.onClick((event) => event.drill(8));
  h.input.onClick((event) => event.drill(40));
  h.click();
  assert.equal(h.calls.drillPick, 1);
});

test('one failing subscriber does not stop the rest', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const error = console.error;
  console.error = () => {};
  t.after(() => (console.error = error));
  let ran = false;
  h.input.onClick(() => {
    throw new Error('boom');
  });
  h.input.onClick(() => (ran = true));
  h.click();
  assert.equal(ran, true);
});

test('destroy releases holds and the handler, and the scene gets a new one', () => {
  const h = harness();
  h.input.suspendCamera('drag');
  h.input.suppressStockClicks();
  h.input.destroy();
  assert.equal(h.handler.destroyed, true);
  const controller = h.viewer.scene.screenSpaceCameraController;
  assert.equal(controller.enableInputs, true);
  assert.ok(
    Object.getOwnPropertyDescriptor(controller, 'enableInputs').writable,
    'the controller gets its plain flag back',
  );
  assert.equal(h.stock.getInputAction(TYPES.LEFT_CLICK), h.stockClick);
  const next = inputFor(h.viewer, {
    createHandler: () => new FakeHandler(),
    eventTypes: TYPES,
  });
  assert.notEqual(next, h.input);
  next.destroy();
});

test('sensor styles move the pick to where the picture came from', () => {
  const stage = { enabled: true, uniforms: { intensity: 1, pixelation: 4 } };
  const scene = {
    canvas: { clientWidth: 400, clientHeight: 200, width: 400, height: 200 },
  };
  registerStyleStages(scene, { surveillance: stage });
  const click = { x: 300, y: 50 };
  const mapped = sensorPickPosition(scene, click);
  assert.notDeepEqual([mapped.x, mapped.y], [300, 50]);
  assert.deepEqual(click, { x: 300, y: 50 }, 'the click is left alone');
  stage.enabled = false;
  const plain = sensorPickPosition(scene, click);
  assert.deepEqual([plain.x, plain.y], [300, 50]);
});

test('the dispatcher is the package input export', async () => {
  const exported = await import('gods-eye-view/input');
  assert.equal(exported.inputFor, inputFor);
});
