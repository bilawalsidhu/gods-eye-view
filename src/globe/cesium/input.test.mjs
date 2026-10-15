import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCesiumInput } from './input.js';
import {
  createFakeEventHandlers,
  createFakeViewer,
} from './testing/fakeViewer.mjs';

const { ScreenSpaceEventType: Type, KeyboardEventModifier: Key } = Cesium;

function setup() {
  const viewer = createFakeViewer();
  const handlers = createFakeEventHandlers();
  const { input, destroy } = createCesiumInput(viewer, {
    createEventHandler: handlers.create,
  });
  return { viewer, input, destroy, handlers: handlers.handlers };
}

test('no handler is created until the first subscription', () => {
  const { handlers, input, viewer } = setup();
  assert.equal(handlers.length, 0);
  input.on('click', () => {});
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].canvas, viewer.scene.canvas);
  input.on('move', () => {});
  assert.equal(handlers.length, 1, 'one shared handler');
});

test('types map to Cesium events and positions arrive as geo copies', () => {
  const { handlers, input } = setup();
  const seen = [];
  input.on('click', (event) => seen.push(['click', event]));
  input.on('doubleClick', (event) => seen.push(['doubleClick', event]));
  input.on('down', (event) => seen.push(['down', event]));
  input.on('up', (event) => seen.push(['up', event]));
  input.on('move', (event) => seen.push(['move', event]));
  const [handler] = handlers;
  const position = new Cesium.Cartesian2(1, 2);
  handler.fire(Type.LEFT_CLICK, { position });
  handler.fire(Type.LEFT_DOUBLE_CLICK, { position });
  handler.fire(Type.LEFT_DOWN, { position });
  handler.fire(Type.LEFT_UP, { position });
  handler.fire(Type.MOUSE_MOVE, {
    startPosition: new Cesium.Cartesian2(3, 4),
    endPosition: new Cesium.Cartesian2(5, 6),
  });
  assert.deepEqual(
    seen.map(([type]) => type),
    ['click', 'doubleClick', 'down', 'up', 'move'],
  );
  const click = seen[0][1];
  assert.ok(!(click.position instanceof Cesium.Cartesian2));
  assert.deepEqual([click.position.x, click.position.y], [1, 2]);
  const move = seen[4][1];
  assert.deepEqual(
    [move.startPosition.x, move.startPosition.y, move.endPosition.x],
    [3, 4, 5],
  );
  assert.ok(!(move.endPosition instanceof Cesium.Cartesian2));
});

test('modifiers register separate Cesium actions', () => {
  const { handlers, input } = setup();
  const seen = [];
  input.on('click', () => seen.push('plain'));
  input.on('click', () => seen.push('ctrl'), { modifier: 'ctrl' });
  input.on('click', () => seen.push('shift'), { modifier: 'shift' });
  input.on('click', () => seen.push('alt'), { modifier: 'alt' });
  const [handler] = handlers;
  const position = new Cesium.Cartesian2(0, 0);
  handler.fire(Type.LEFT_CLICK, { position }, Key.CTRL);
  handler.fire(Type.LEFT_CLICK, { position }, Key.SHIFT);
  handler.fire(Type.LEFT_CLICK, { position }, Key.ALT);
  handler.fire(Type.LEFT_CLICK, { position });
  assert.deepEqual(seen, ['ctrl', 'shift', 'alt', 'plain']);
  assert.throws(() => input.on('click', () => {}, { modifier: 'meta' }));
  assert.throws(() => input.on('wheel', () => {}));
});

test('listeners share an action, removers are idempotent and the action goes with the last', () => {
  const { handlers, input } = setup();
  const seen = [];
  const offA = input.on('click', () => seen.push('a'));
  const offB = input.on('click', () => seen.push('b'));
  const [handler] = handlers;
  const key = `${Type.LEFT_CLICK}:undefined`;
  handler.fire(Type.LEFT_CLICK, { position: new Cesium.Cartesian2() });
  assert.deepEqual(seen, ['a', 'b']);
  offA();
  offA();
  assert.ok(handler.actions.has(key));
  handler.fire(Type.LEFT_CLICK, { position: new Cesium.Cartesian2() });
  assert.deepEqual(seen, ['a', 'b', 'b']);
  offB();
  assert.ok(!handler.actions.has(key));
});

test('setCameraInputs toggles the camera controller', () => {
  const { viewer, input } = setup();
  input.setCameraInputs(false);
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false);
  input.setCameraInputs(true);
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, true);
});

test('destroy destroys the handler', () => {
  const { handlers, input, destroy } = setup();
  input.on('click', () => {});
  destroy();
  assert.equal(handlers[0].destroyed, true);
});
