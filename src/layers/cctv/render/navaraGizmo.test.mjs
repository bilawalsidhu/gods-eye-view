import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { viewshedColors } from '../../../data/cctvViewshed.js';
import { createNavaraCctvGizmoRenderer } from './navaraGizmo.js';

const color = viewshedColors(30).fill;

test('Navara gizmo releases arrow resources, input and cancellation listeners', () => {
  const engine = createFakeEngine({ kind: 'navara' });
  const canvas = new EventTarget();
  const window = new EventTarget();
  canvas.style = {};
  canvas.ownerDocument = { defaultView: window };
  engine.host.canvas = canvas;
  const renderer = createNavaraCctvGizmoRenderer(engine);
  renderer.createLine('east', color, 8, true);
  renderer.createLine('heading', color, 3);
  renderer.createPoint('range', color, 10);
  let cancels = 0;
  let moves = 0;
  renderer.on('cancel', () => cancels++);
  renderer.on('move', () => moves++);
  canvas.dispatchEvent(new Event('pointercancel'));
  window.dispatchEvent(new Event('blur'));
  engine.fake.input('move', { position: { x: 1, y: 1 } });
  assert.equal(cancels, 2);
  assert.equal(moves, 1);
  assert.throws(
    () => renderer.createLine('east', color, 8, true),
    /already owned/,
  );
  assert.equal(engine.lines.list().length, 2);
  assert.equal(engine.movers.list().length, 2);
  renderer.setCursor('grabbing');
  renderer.destroy();
  renderer.destroy();
  canvas.dispatchEvent(new Event('pointercancel'));
  window.dispatchEvent(new Event('blur'));
  engine.fake.input('move', { position: { x: 1, y: 1 } });
  assert.equal(cancels, 2);
  assert.equal(moves, 1);
  assert.equal(engine.lines.list().length, 0);
  assert.equal(engine.movers.list().length, 0);
  assert.equal(canvas.style.cursor, '');
  assert.throws(() => renderer.createPoint('new', color, 10), /destroyed/);
});

test('Navara gizmo rolls back the arrow shaft if its tip cannot be allocated', () => {
  const engine = createFakeEngine({ kind: 'navara' });
  engine.movers.createSet = () => {
    throw new Error('allocation failed');
  };
  const renderer = createNavaraCctvGizmoRenderer(engine);
  assert.throws(
    () => renderer.createLine('east', color, 8, true),
    /allocation failed/,
  );
  assert.equal(engine.lines.list().length, 0);
  renderer.destroy();
});
