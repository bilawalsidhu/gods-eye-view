import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inputFor, pickAt } from './dispatcher.js';
import { bindRenderer, findInput } from '../render/rendererOf.js';
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
    isDestroyed: () => false,
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

test('a click on a draw-set item reads as its hit; anything else as none', (t) => {
  let picked = {
    id: { set: 'quakes:1', id: 'quake:a', meta: { mag: 5 } },
    primitive: {},
  };
  const h = harness({ pick: () => picked });
  t.after(() => h.input.destroy());
  const seen = [];
  h.input.onClick((event) => seen.push([event.drawHit, event.drawHit]));
  h.click();
  assert.equal(h.calls.pick, 1, 'one pick serves the hit');
  assert.deepEqual(seen[0][0], {
    set: 'quakes:1',
    id: 'quake:a',
    meta: { mag: 5 },
    surface: false,
  });
  assert.equal(seen[0][0], seen[0][1], 'read once per click');
  picked = { id: { set: 'quakes:1', id: 'quake:b' } };
  h.click();
  assert.deepEqual(seen.at(-1)[0], {
    set: 'quakes:1',
    id: 'quake:b',
    surface: false,
  });
  for (picked of [
    { id: 'plane-1' },
    { id: { id: 'entity' } },
    { id: { set: 'quakes:1', id: 7 } },
    { id: { set: null, id: 'quake:c' } },
    undefined,
  ]) {
    h.click();
    assert.equal(seen.at(-1)[0], null);
  }
});

test('a click nobody reads is never picked', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  h.input.onClick(() => {});
  h.click();
  assert.equal(h.calls.pick, 0);
});

test('a painted overlay can claim a click before its underlying owner', (t) => {
  registerPickOwner('satellites', (id) => id === '25544');
  t.after(() => unregisterPickOwner('satellites'));
  const h = harness({ pick: () => ({ id: '25544' }) });
  t.after(() => h.input.destroy());
  const clicks = [];

  h.input.onClick((event) => clicks.push(event.ownerId));
  const offOverlay = h.input.onOverlayClick(({ screenPosition }) => {
    if (screenPosition.x !== 10) return false;
    clicks.push('mission label');
    return true;
  });
  h.input.onPointer('click', () => clicks.push('ambient pointer'));

  h.click();
  // The click still reaches every subscriber, as one on the label.
  assert.deepEqual(clicks, ['mission label', 'ambient pointer', null]);
  assert.equal(h.calls.pick, 0);

  h.click(11, 10);
  offOverlay();
  h.click();
  assert.deepEqual(clicks, [
    'mission label',
    'ambient pointer',
    null,
    'ambient pointer',
    'satellites',
    'ambient pointer',
    'satellites',
  ]);
});

test('a click a painted overlay handles still reaches subscribers that clear selection', (t) => {
  const h = harness({
    pick: () => ({ set: 'flights', id: 'abc123' }),
    drillPick: () => [{ set: 'flights', id: 'abc123' }],
  });
  t.after(() => h.input.destroy());
  let seenByOverlay = null;
  h.input.onOverlayClick((event) => {
    seenByOverlay = event;
    return true;
  });
  const seen = [];
  h.input.onClick((event) => {
    seen.push({
      same: event === seenByOverlay,
      overlay: event.overlay,
      topHit: event.topHit,
      drawHit: event.drawHit,
      hit: event.hit,
      id: event.id,
      ownerId: event.ownerId,
      surface: event.surface,
      drill: event.drill(4),
      windowHit: event.windowHit(8, 8),
      pick: event.pick,
    });
  });
  h.click();
  assert.deepEqual(seen, [
    {
      same: true,
      overlay: true,
      topHit: { set: '', id: null, surface: false },
      drawHit: null,
      hit: { set: '', id: null, surface: false },
      id: null,
      ownerId: null,
      surface: false,
      drill: [],
      windowHit: { id: null, drawHit: null, surface: false },
      pick: undefined,
    },
  ]);
  assert.equal(h.calls.pick, 0, 'the geometry beneath is not picked');
  assert.equal(h.calls.drillPick, 0);

  // Without an overlay target the same click picks the geometry.
  seen.length = 0;
  h.input.destroy();
  const g = harness({ pick: () => ({ set: 'flights', id: 'abc123' }) });
  t.after(() => g.input.destroy());
  g.input.onClick((event) => seen.push([event.overlay, event.topHit]));
  g.click();
  assert.equal(seen[0][0], false);
  assert.equal(g.calls.pick, 1);
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

test("a tool's claim holds the renderer's input port without taking its presses", (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const port = findInput(h.viewer);
  const heard = [];
  port.on('click', () => heard.push('port'));
  const lease = claimPointer('test-tool');
  t.after(() => releasePointer(lease));
  h.input.onPointer('click', () => heard.push('tool'), { lease });
  assert.equal(port.isPointerFree(), false);
  h.click();
  // Who hears a click is decided here, when it arrives; the port gives
  // every press on, so the renderer's own select runs unless held off.
  assert.deepEqual(heard, ['tool', 'port']);
  releasePointer(lease);
  assert.equal(port.isPointerFree(), true);
  h.click();
  assert.deepEqual(heard, ['tool', 'port', 'port']);
});

test('a click goes where the pointer is when it arrives: a tool that claims during the press gets it, ambient selection does not', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const heard = [];
  h.input.onClick(() => heard.push('ambient'));
  let lease = null;
  h.input.onPointer('click', () => heard.push('tool'), {
    lease: () => lease,
  });
  h.input.onPointer('dblclick', () => heard.push('tool:dblclick'), {
    lease: () => lease,
  });
  h.input.onPointer('dblclick', () => heard.push('ambient:dblclick'));
  h.handler.fire(TYPES.LEFT_DOWN, { position: { x: 10, y: 10 } });
  lease = claimPointer('test-tool');
  t.after(() => releasePointer(lease));
  h.handler.fire(TYPES.LEFT_UP, { position: { x: 10, y: 10 } });
  h.handler.fire(TYPES.LEFT_CLICK, { position: { x: 10, y: 10 } });
  h.handler.fire(TYPES.LEFT_DOUBLE_CLICK, { position: { x: 10, y: 10 } });
  assert.deepEqual(heard, ['tool', 'tool:dblclick']);
});

test('a click goes where the pointer is when it arrives: after a tool lets go during the press, ambient selection gets it', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const heard = [];
  h.input.onClick(() => heard.push('ambient'));
  const lease = claimPointer('test-tool');
  t.after(() => releasePointer(lease));
  h.input.onPointer('click', () => heard.push('tool'), { lease });
  h.input.onPointer('dblclick', () => heard.push('ambient:dblclick'));
  h.handler.fire(TYPES.LEFT_DOWN, { position: { x: 10, y: 10 } });
  releasePointer(lease);
  h.handler.fire(TYPES.LEFT_UP, { position: { x: 10, y: 10 } });
  h.handler.fire(TYPES.LEFT_CLICK, { position: { x: 10, y: 10 } });
  h.handler.fire(TYPES.LEFT_DOUBLE_CLICK, { position: { x: 10, y: 10 } });
  assert.deepEqual(heard, ['ambient', 'ambient:dblclick']);
});

test("a claim on the renderer's port takes over from the tool, which is told", (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const port = findInput(h.viewer);
  const told = [];
  const heard = [];
  const lease = claimPointer('test-tool', { onLost: () => told.push('tool') });
  h.input.onPointer('click', () => heard.push('tool'), { lease });
  h.input.onClick(() => heard.push('ambient'));
  const other = port.claimPointer('other');
  t.after(() => other.release());
  port.on('click', () => heard.push('other'), { lease: other });
  assert.deepEqual(told, ['tool']);
  h.click();
  assert.deepEqual(
    heard,
    ['other'],
    'neither the old tool nor ambient selection',
  );
  releasePointer(lease);
  assert.equal(other.current, true, "the old tool's release frees nothing");
});

test('destroy gives the port its lease back', () => {
  const h = harness();
  const port = findInput(h.viewer);
  const lease = claimPointer('test-tool');
  assert.equal(port.isPointerFree(), false);
  h.input.destroy();
  assert.equal(port.isPointerFree(), true);
  releasePointer(lease);
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
  const hits = Array.from({ length: 20 }, (_, i) => ({
    id: { set: 'test:1', id: `hit-${i}` },
  }));
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

function coarsePointer(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query) => ({ matches: query === '(pointer: coarse)' }),
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'matchMedia', previous);
    else delete globalThis.matchMedia;
  });
}

test('a touch tap finds the contact under the map, in one drill of its own', (t) => {
  coarsePointer(t);
  registerPickOwner('test-owner', (id) => id === 'plane-1');
  t.after(() => unregisterPickOwner('test-owner'));
  const tile = { primitive: { isCesium3DTileset: true } };
  const drills = [];
  const h = harness({
    pick: () => tile,
    drillPick: (_p, limit, width, height) => {
      drills.push([limit, width, height]);
      return [tile, { id: { set: 'test:1', id: 'plane-1' } }];
    },
  });
  t.after(() => h.input.destroy());
  const seen = [];
  h.input.onClick((event) => seen.push(event.id, event.drawHit));
  h.click();
  assert.deepEqual(seen, ['plane-1', null]);
  assert.deepEqual(drills, [[8, 14, 14]], 'eight deep, as before');
});

test('a touch tap finds a contact drawn outside the draw port', (t) => {
  coarsePointer(t);
  registerPickOwner('test-owner', (id) => id === 'bus-1');
  t.after(() => unregisterPickOwner('test-owner'));
  const h = harness({
    pick: () => undefined,
    drillPick: () => [{ primitive: { id: 'bus-1' } }],
  });
  t.after(() => h.input.destroy());
  const seen = [];
  h.input.onClick((event) => seen.push(event.id, event.ownerId));
  h.click();
  assert.deepEqual(seen, ['bus-1', 'test-owner']);
});

test('a touch tap stops at something drawn outside the draw port over a contact', (t) => {
  coarsePointer(t);
  registerPickOwner('test-owner', (id) => id === 'plane-1');
  t.after(() => unregisterPickOwner('test-owner'));
  const h = harness({
    pick: () => undefined,
    drillPick: () => [
      { primitive: { id: 'unowned' } },
      { id: { set: 'test:1', id: 'plane-1' } },
    ],
  });
  t.after(() => h.input.destroy());
  const seen = [];
  h.input.onClick((event) => seen.push(event.id));
  h.click();
  assert.deepEqual(seen, [null], 'the map under the tap, as before');
});

test('a deeper ask than a short drill looks again: it held draw-set items only', (t) => {
  const h = harness({
    drillPick: () => [{ id: { set: 'test:1', id: 'only' } }],
  });
  t.after(() => h.input.destroy());
  h.input.onClick((event) => event.drill(8));
  h.input.onClick((event) => event.drill(12));
  h.input.onClick((event) => event.drill(40));
  h.click();
  assert.equal(h.calls.drillPick, 2, '16 deep, then 40');
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
  const mapped = sensorPickPosition(scene, click, scene.canvas);
  assert.notDeepEqual([mapped.x, mapped.y], [300, 50]);
  assert.deepEqual(click, { x: 300, y: 50 }, 'the click is left alone');
  stage.enabled = false;
  const plain = sensorPickPosition(scene, click, scene.canvas);
  assert.deepEqual([plain.x, plain.y], [300, 50]);
});

test('a move carries its pick-buffer position, sensor-corrected as a click is', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  Object.assign(h.viewer.scene.canvas, {
    clientWidth: 400,
    clientHeight: 200,
    width: 400,
    height: 200,
  });
  const stage = { enabled: true, uniforms: { intensity: 1, pixelation: 4 } };
  registerStyleStages(h.viewer.scene, { surveillance: stage });
  const seen = [];
  h.input.onPointer('move', (event) => seen.push(event));
  h.handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 300, y: 50 } });
  const expected = sensorPickPosition(
    h.viewer.scene,
    { x: 300, y: 50 },
    h.viewer.scene.canvas,
  );
  assert.deepEqual(
    [seen[0].pickPosition.x, seen[0].pickPosition.y],
    [expected.x, expected.y],
  );
  assert.deepEqual([seen[0].endPosition.x, seen[0].endPosition.y], [300, 50]);
});

test('the dispatcher is the package input export', async () => {
  const exported = await import('gods-eye-view/input');
  assert.equal(exported.inputFor, inputFor);
});

test('something drawn outside the draw port is the top hit, with no set, and never a draw hit', (t) => {
  registerPickOwner('test-owner', (id) => id === 'bus-1');
  t.after(() => unregisterPickOwner('test-owner'));
  let picked = { primitive: { id: 'bus-1' } };
  const h = harness({ pick: () => picked });
  t.after(() => h.input.destroy());
  const seen = [];
  h.input.onClick((event) =>
    seen.push({
      top: event.topHit,
      draw: event.drawHit,
      id: event.id,
      owner: event.ownerId,
      surface: event.surface,
      native: event.native.pick,
    }),
  );
  h.click();
  assert.equal(h.calls.pick, 1, "the adapter's own pick reuses the renderer's");
  assert.deepEqual(seen[0].top, { set: '', id: 'bus-1', surface: false });
  assert.equal(seen[0].draw, null);
  assert.equal(seen[0].id, 'bus-1');
  assert.equal(seen[0].owner, 'test-owner');
  assert.equal(seen[0].surface, false);
  assert.equal(
    seen[0].native,
    picked,
    "the engine's own pick, for code bound to it",
  );
  picked = { primitive: { isCesium3DTileset: true } };
  h.click();
  assert.equal(seen[1].top, null, 'tiles are the map');
  assert.equal(seen[1].surface, true);
  assert.equal(seen[1].id, null);
});

test('pick and pickWindow still hand over the engine pick objects, one pass each', (t) => {
  const picked = { primitive: { id: 'bus-1' } };
  const h = harness({ pick: () => picked });
  t.after(() => h.input.destroy());
  const seen = [];
  h.input.onClick((event) =>
    seen.push({
      pick: event.pick,
      window: event.pickWindow(9, 9),
      windowId: event.windowHit(9, 9).id,
    }),
  );
  h.click();
  assert.equal(seen[0].pick, picked);
  assert.equal(seen[0].window, picked);
  assert.equal(seen[0].windowId, 'bus-1');
  assert.equal(h.calls.pick, 2, 'one pass at 3x3 and one at 9x9');
});

test("a draw-set item the renderer's sets do not hold is still the click's draw hit", (t) => {
  const picked = { id: { set: 'kept:1', id: 'a', meta: { k: 1 } } };
  const h = harness({ pick: () => picked });
  t.after(() => h.input.destroy());
  // The renderer's pick names nothing there: its sets do not hold `kept:1`.
  t.after(bindRenderer(h.viewer, { query: { pick: () => null } }));
  const seen = [];
  h.input.onClick((event) => seen.push(event.drawHit?.id, event.meta?.k));
  h.click();
  assert.deepEqual(seen, ['a', 1]);
});

test("a click's engine pick is the renderer's pass, even when read later", async (t) => {
  let picked = { primitive: { id: 'bus-1' } };
  const h = harness({ pick: () => picked });
  t.after(() => h.input.destroy());
  const events = [];
  h.input.onClick((event) => events.push(event) && event.topHit);
  h.click();
  picked = { primitive: { id: 'bus-2' } };
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events[0].topHit.id, 'bus-1');
  assert.equal(events[0].pick.primitive.id, 'bus-1');
  assert.equal(events[0].native.pick.primitive.id, 'bus-1');
  assert.equal(h.calls.pick, 1);
});

test('positions are plain CSS pixels', (t) => {
  const h = harness();
  t.after(() => h.input.destroy());
  const seen = [];
  h.input.onPointer('down', (event) => seen.push(event.position));
  h.input.onPointer('move', (event) => seen.push(event.endPosition));
  h.input.onClick((event) => seen.push(event.screenPosition, event.position));
  h.handler.fire(TYPES.MOUSE_MOVE, { endPosition: { x: 3, y: 4 } });
  h.click(5, 6);
  for (const position of seen) {
    assert.equal(Object.getPrototypeOf(position), Object.prototype);
    assert.deepEqual(Object.keys(position), ['x', 'y']);
  }
  assert.deepEqual(seen.at(-1), { x: 5, y: 6 });
});

test("a viewer's renderer gives the dispatcher its input and query ports", (t) => {
  const listeners = new Map();
  const holds = [];
  const port = {
    on(type, cb) {
      listeners.set(type, cb);
      return () => listeners.delete(type);
    },
    suspendCameraControls(reason) {
      holds.push(reason);
      return () => holds.splice(holds.indexOf(reason), 1);
    },
    behaviours: {
      select: { enabled: true, suppress: () => () => {} },
      dblclickFollow: { enabled: false, suppress: () => () => {} },
    },
  };
  const hit = { set: 'quakes:1', id: 'quake:a', surface: false };
  const asked = [];
  const query = {
    pick: (x, y, window) => (asked.push(['pick', x, y, window]), hit),
    drillPick: () => [],
    pickPosition: () => ({ x: 6378137, y: 0, z: 0 }),
    pickEllipsoid: () => null,
  };
  const viewer = {};
  const unbind = bindRenderer(viewer, { input: port, query });
  t.after(unbind);
  const input = inputFor(viewer);
  t.after(() => input.destroy());
  assert.equal(input.stockEnabled('select'), true);
  assert.equal(input.stockEnabled('dblclickFollow'), false);
  input.suspendCamera('drag');
  assert.deepEqual(holds, ['drag']);
  const seen = [];
  input.onClick((event) => seen.push([event.drawHit, event.ground()]));
  listeners.get('click')({
    type: 'click',
    position: { x: 7, y: 8 },
    button: 0,
    modifiers: { shift: false, ctrl: false, alt: false, meta: false },
  });
  assert.equal(seen[0][0], hit);
  assert.deepEqual(seen[0][1], { x: 6378137, y: 0, z: 0 });
  assert.deepEqual(asked, [['pick', 7, 8, undefined]]);
  assert.equal(pickAt(viewer, 1, 2), hit, 'point-and-ask picks the same way');
  input.destroy();
  assert.deepEqual(holds, [], "destroy gives back the dispatcher's holds");
  assert.equal(listeners.size, 0);
});

test('a viewer with no renderer and no adapter factory cannot take input', () => {
  // The adapter's factory builds over anything with a scene: this has none.
  assert.throws(() => inputFor({}), /no renderer to take input with/);
});

test('point-and-ask: nothing but the map is no hit; a failing pick is none', (t) => {
  const surface = { set: '', id: '', surface: true };
  const viewer = {};
  let pick = () => surface;
  t.after(bindRenderer(viewer, { query: { pick: (...a) => pick(...a) } }));
  assert.equal(pickAt(viewer, 0, 0), null);
  pick = () => {
    throw new Error('context lost');
  };
  assert.equal(pickAt(viewer, 0, 0), null);
  assert.equal(pickAt(null, 0, 0), null);
});
