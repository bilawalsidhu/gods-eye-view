import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { createCesiumInput } from './input.js';

const T = Cesium.ScreenSpaceEventType;
const { SHIFT } = Cesium.KeyboardEventModifier;

/** A ScreenSpaceEventHandler that records its actions and fires them. */
function fakeHandler() {
  const actions = new Map();
  const key = (type, modifier) => `${type}:${modifier ?? ''}`;
  let destroyed = false;
  return {
    setInputAction: (fn, type, modifier) =>
      actions.set(key(type, modifier), fn),
    getInputAction: (type, modifier) => actions.get(key(type, modifier)),
    removeInputAction: (type, modifier) => actions.delete(key(type, modifier)),
    fire: (type, event, modifier) => actions.get(key(type, modifier))?.(event),
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      actions.clear();
    },
  };
}

function fakeCanvas() {
  const listeners = new Map();
  return {
    clientHeight: 300,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    dispatch: (type, event) => listeners.get(type)?.(event),
    listeners,
  };
}

/** A document that hands its capture listeners each event first. */
function fakeDocument() {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    fire: (event) => listeners.get(event.type)?.(event),
    listeners,
  };
}

function setup({ stock = true, document = null } = {}) {
  const stockHandler = fakeHandler();
  const selected = [];
  const followed = [];
  if (stock) {
    stockHandler.setInputAction((e) => selected.push(e.position), T.LEFT_CLICK);
    stockHandler.setInputAction(
      (e) => followed.push(e.position),
      T.LEFT_DOUBLE_CLICK,
    );
  }
  const controller = { enableInputs: true };
  const canvas = fakeCanvas();
  const widget = {
    scene: { canvas, screenSpaceCameraController: controller },
    screenSpaceEventHandler: stockHandler,
  };
  const passes = { pick: 0, drill: 0 };
  const query = {
    pick: () => (passes.pick++, { id: 'hit' }),
    drillPick: (x, y, { limit } = {}) => {
      passes.drill++;
      const all = ['a', 'b', 'c'].map((id) => ({ id }));
      return limit === undefined ? all : all.slice(0, limit);
    },
    pickPosition: () => null,
    pickEllipsoid: () => ({ x: 1, y: 2, z: 3 }),
  };
  const handler = fakeHandler();
  const errors = [];
  const wheelZoom = [];
  let clock = 0;
  const input = createCesiumInput(widget, {
    query,
    report: (error) => errors.push(error),
    createHandler: () => handler,
    now: () => clock,
    document,
    ctrlWheelZoom: () => {
      wheelZoom.push('on');
      return () => wheelZoom.push('off');
    },
  });
  const at = (x, y) => new Cesium.Cartesian2(x, y);
  const press = (x, y, modifier) => {
    handler.fire(T.LEFT_DOWN, { position: at(x, y) }, modifier);
    handler.fire(T.LEFT_UP, { position: at(x, y) }, modifier);
    handler.fire(T.LEFT_CLICK, { position: at(x, y) }, modifier);
  };
  return {
    input,
    port: input.port,
    handler,
    stockHandler,
    selected,
    followed,
    controller,
    canvas,
    passes,
    errors,
    wheelZoom,
    press,
    at,
    tick: (ms) => (clock += ms),
  };
}

test('the stock select runs ahead of the subscribers, for a click that is theirs', () => {
  const s = setup();
  assert.equal(
    s.stockHandler.getInputAction(T.LEFT_CLICK),
    undefined,
    'taken off the viewer’s handler',
  );
  const order = [];
  s.port.on('click', () => order.push(`heard ${s.selected.length}`));
  s.press(5, 6);
  assert.deepEqual(order, ['heard 1'], 'it has run already');
  assert.equal(s.selected.length, 1);
  assert.deepEqual({ x: s.selected[0].x, y: s.selected[0].y }, { x: 5, y: 6 });
  s.handler.fire(T.LEFT_DOUBLE_CLICK, { position: s.at(5, 6) });
  assert.equal(s.followed.length, 1, 'and follow on a double-click');
});

test('a lease, a grab or a suppression keeps the stock select off', () => {
  const s = setup();
  const lease = s.port.claimPointer('tool');
  s.press(5, 6);
  assert.equal(s.selected.length, 0, 'under a lease');
  lease.release();
  const grabbing = s.port.claimPointer('draw', {
    grab: (down) => down.position.x < 100,
  });
  s.press(5, 6);
  assert.equal(s.selected.length, 0, 'a grabbed press');
  s.press(500, 6);
  assert.equal(s.selected.length, 1, 'a press the grab left');
  grabbing.release();
  const off = s.port.behaviours.select.suppress();
  s.press(5, 6);
  assert.equal(s.selected.length, 1, 'while suppressed');
  off();
  s.press(5, 6, SHIFT);
  assert.equal(s.selected.length, 1, 'a modified click never ran it');
  s.press(5, 6);
  assert.equal(s.selected.length, 2, 'back');
  s.handler.fire(T.LEFT_DOUBLE_CLICK, { position: s.at(5, 6) });
  const offFollow = s.port.behaviours.dblclickFollow.suppress();
  s.handler.fire(T.LEFT_DOUBLE_CLICK, { position: s.at(5, 6) });
  assert.equal(s.followed.length, 1, 'follow is suppressed on its own');
  offFollow();
});

test('dispose gives the viewer its stock actions back', () => {
  const s = setup();
  s.input.dispose();
  s.stockHandler.fire(T.LEFT_CLICK, { position: s.at(1, 2) });
  s.stockHandler.fire(T.LEFT_DOUBLE_CLICK, { position: s.at(1, 2) });
  assert.equal(s.selected.length, 1);
  assert.equal(s.followed.length, 1);
  assert.ok(s.handler.isDestroyed());
  assert.equal(s.canvas.listeners.size, 0, 'the wheel listener is gone');
});

test('a widget without stock actions reports them disabled', () => {
  const s = setup({ stock: false });
  assert.equal(s.port.behaviours.select.enabled, false);
  assert.equal(s.port.behaviours.dblclickFollow.enabled, false);
});

test('a click carries its gesture and one pick, drill and ground', () => {
  const s = setup();
  const clicks = [];
  s.port.on('click', (ev) => clicks.push(ev));
  s.handler.fire(T.LEFT_DOWN, { position: s.at(0, 0) });
  s.tick(80);
  s.handler.fire(T.MOUSE_MOVE, {
    startPosition: s.at(0, 0),
    endPosition: s.at(3, 4),
  });
  s.handler.fire(T.LEFT_UP, { position: s.at(3, 4) });
  s.handler.fire(T.LEFT_CLICK, { position: s.at(3, 4) });
  const [ev] = clicks;
  assert.deepEqual(ev.gesture, { travelPx: 5, durationMs: 80 });
  assert.equal(ev.pick(), ev.pick(), 'one pick object');
  assert.equal(s.passes.pick, 1);
  assert.deepEqual(
    ev.drill({ limit: 1 }).map((h) => h.id),
    ['a'],
  );
  assert.deepEqual(
    ev.drill().map((h) => h.id),
    ['a', 'b', 'c'],
  );
  assert.equal(s.passes.drill, 1, 'a short pass found everything');
  assert.deepEqual(ev.ground(), { x: 1, y: 2, z: 3 });
  s.handler.fire(T.LEFT_CLICK, { position: s.at(3, 4) });
  assert.deepEqual(
    clicks[1].gesture,
    { travelPx: 0, durationMs: 0 },
    'a click with no press of its own',
  );
});

test('camera holds turn the controller’s input off until the last release', () => {
  const s = setup();
  const a = s.port.suspendCameraControls('a');
  const b = s.port.suspendCameraControls('b');
  assert.equal(s.controller.enableInputs, false);
  a();
  assert.equal(s.controller.enableInputs, false);
  b();
  assert.equal(s.controller.enableInputs, true);
  s.port.suspendCameraControls('left out');
  s.input.dispose();
  assert.equal(s.controller.enableInputs, true, 'dispose gives them back');
});

test('ctrlWheelZoom installs the zoom and takes it out again', () => {
  const s = setup();
  s.port.ctrlWheelZoom = true;
  s.port.ctrlWheelZoom = true;
  s.port.ctrlWheelZoom = false;
  s.port.ctrlWheelZoom = true;
  s.input.dispose();
  assert.deepEqual(s.wheelZoom, ['on', 'off', 'on', 'off']);
});

test('wheel is in lines, where the pointer is over the canvas', () => {
  const s = setup();
  const wheels = [];
  s.port.on('wheel', (ev) =>
    wheels.push([ev.position, ev.delta, ev.modifiers]),
  );
  s.canvas.dispatch('wheel', {
    clientX: 110,
    clientY: 220,
    deltaY: 100,
    deltaMode: 0,
    ctrlKey: true,
  });
  s.canvas.dispatch('wheel', {
    clientX: 10,
    clientY: 20,
    deltaY: -3,
    deltaMode: 1,
  });
  assert.deepEqual(wheels[0][0], { x: 100, y: 200 });
  assert.equal(wheels[0][1], 3);
  assert.equal(wheels[0][2].ctrl, true);
  assert.equal(wheels[1][1], -3);
});

test('a pinch is the scale since the last event, at its midpoint', () => {
  const s = setup();
  const pinches = [];
  s.port.on('pinch', (ev) => pinches.push([ev.position, ev.delta]));
  s.handler.fire(T.PINCH_START, {
    position1: s.at(0, 0),
    position2: s.at(10, 20),
  });
  s.handler.fire(T.PINCH_MOVE, {
    distance: { startPosition: s.at(0, 4), endPosition: s.at(0, 5) },
  });
  assert.deepEqual(pinches, [[{ x: 5, y: 10 }, 1.25]]);
});

test('a throwing stock action is reported', () => {
  const stockHandler = fakeHandler();
  const boom = new Error('stock');
  stockHandler.setInputAction(() => {
    throw boom;
  }, T.LEFT_CLICK);
  const handler = fakeHandler();
  const errors = [];
  createCesiumInput(
    {
      scene: { canvas: fakeCanvas(), screenSpaceCameraController: {} },
      screenSpaceEventHandler: stockHandler,
    },
    {
      query: { pick: () => null },
      report: (error) => errors.push(error),
      createHandler: () => handler,
      document: null,
    },
  );
  handler.fire(T.LEFT_CLICK, { position: new Cesium.Cartesian2(1, 1) });
  assert.deepEqual(errors, [boom]);
});

test('releasing one button ends the others’ presses without their clicks', () => {
  const doc = fakeDocument();
  const s = setup({ document: doc });
  const heard = [];
  for (const type of ['up', 'click'])
    s.port.on(type, (ev) => heard.push(`${type}:${ev.button}`));
  const mouse = (type, button) =>
    doc.fire({ type, button, pointerType: 'mouse' });
  mouse('pointerdown', 0);
  s.handler.fire(T.LEFT_DOWN, { position: s.at(5, 6) });
  mouse('pointerdown', 2);
  s.handler.fire(T.RIGHT_DOWN, { position: s.at(5, 6) });
  // Cesium answers the right release with both buttons' up and click.
  mouse('pointerup', 2);
  s.handler.fire(T.LEFT_UP, { position: s.at(5, 6) });
  s.handler.fire(T.LEFT_CLICK, { position: s.at(5, 6) });
  s.handler.fire(T.RIGHT_UP, { position: s.at(5, 6) });
  s.handler.fire(T.RIGHT_CLICK, { position: s.at(5, 6) });
  assert.deepEqual(heard, ['up:0', 'up:2', 'click:2']);
  assert.equal(s.selected.length, 0, 'no select while left was held');
});

test('an action raised after its DOM event takes Cesium’s modifier', async () => {
  const doc = fakeDocument();
  const s = setup({ document: doc });
  const heard = [];
  s.port.on('click', (ev) => heard.push([ev.modifiers, ev.pointerType]));
  doc.fire({ type: 'pointerdown', button: 0, pointerType: 'touch' });
  doc.fire({ type: 'pointermove', pointerType: 'mouse', ctrlKey: true });
  doc.fire({ type: 'pointerdown', button: 0, pointerType: 'touch' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // A touch held for a right click, raised on Cesium's timer.
  s.handler.fire(T.RIGHT_CLICK, { position: s.at(5, 6) }, SHIFT);
  assert.deepEqual(heard, [
    [{ shift: true, ctrl: false, alt: false, meta: false }, 'touch'],
  ]);
});

test('a subscriber that disposes the port stops the rest of the click', () => {
  const s = setup();
  const heard = [];
  s.port.on('click', () => {
    heard.push('first');
    s.input.dispose();
  });
  s.port.on('click', () => heard.push('second'));
  s.press(5, 6);
  assert.deepEqual(heard, ['first']);
  assert.equal(s.selected.length, 1, 'the stock select had run first');
  s.port.ctrlWheelZoom = true;
  assert.deepEqual(s.wheelZoom, [], 'nothing installs after dispose');
});

test('a double-tap is a touch; a click on Cesium’s timer ends no press', () => {
  const doc = fakeDocument();
  const s = setup({ document: doc });
  const heard = [];
  s.port.on('dblclick', (ev) => heard.push(ev.pointerType));
  s.port.on('click', (ev) => heard.push(ev.gesture));
  doc.fire({ type: 'pointerdown', button: 0, pointerType: 'touch' });
  doc.fire({ type: 'dblclick' });
  s.handler.fire(T.LEFT_DOUBLE_CLICK, { position: s.at(5, 6) });
  // A right drag that ended without a click, then a held touch.
  doc.fire({ type: 'pointerdown', button: 2, pointerType: 'mouse' });
  s.handler.fire(T.RIGHT_DOWN, { position: s.at(0, 0) });
  s.tick(50);
  doc.fire({ type: 'pointerup', button: 2, pointerType: 'mouse' });
  s.handler.fire(T.RIGHT_UP, { position: s.at(30, 40) });
  // The touch starts a press of its own, held until Cesium's timer.
  doc.fire({ type: 'pointerdown', button: 0, pointerType: 'touch' });
  s.handler.fire(T.LEFT_DOWN, { position: s.at(5, 6) });
  doc.listeners.clear();
  s.handler.fire(T.RIGHT_CLICK, { position: s.at(5, 6) });
  assert.deepEqual(heard, ['touch', { travelPx: 0, durationMs: 0 }]);
});
