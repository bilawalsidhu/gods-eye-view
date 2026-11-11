import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimPointer,
  pointerOwner,
  releasePointer,
  resetPointerOwnership,
} from '../data/inputOwnership.js';
import {
  IMAGERY_BOX_POINTER_OWNER,
  initImageryBoxTool,
} from './imageryBoxTool.js';
import { boxToolFakes } from '../layers/recentImagery/testDoubles.mjs';

function fixture(options = {}) {
  resetPointerOwnership();
  const fakes = boxToolFakes();
  const boxes = [];
  const cancels = [];
  const actives = [];
  const previews = [];
  const tool = initImageryBoxTool({
    engine: fakes.engine,
    pickWorld: fakes.pickWorld,
    documentRef: fakes.documentRef,
    onBox: (box) => boxes.push(box),
    onPreview: (box) => previews.push(box),
    onCancel: (reason, message) => cancels.push([reason, message]),
    onActive: (active) => actives.push(active),
    ...options,
  });
  return { ...fakes, tool, boxes, cancels, actives, previews };
}

const listenerCount = (f) =>
  f.canvas.listeners.length +
  f.documentRef.listeners.length +
  f.windowRef.listeners.length;

test('a session claims the pointer, keeps the drag from the engine, freezes the camera only mid-drag and returns everything with the box', () => {
  const f = fixture();
  assert.equal(f.tool.start(), true);
  assert.equal(pointerOwner(), IMAGERY_BOX_POINTER_OWNER);
  assert.ok(f.documentRef.classes.has('gev-imagery-box'));
  assert.equal(f.camera.inputs, true, 'not frozen before the press');
  const press = f.down({ x: 250, y: 125 });
  assert.equal(
    press.prevented && press.stopped,
    true,
    'the press reaches no other handler (camera, clicks)',
  );
  assert.equal(f.camera.inputs, false);
  assert.ok(f.captured.has(1), 'the drag holds the pointer capture');
  assert.ok(f.previews.at(-1), 'the preview shows');
  const drag = f.move({ x: 500, y: 250 });
  assert.equal(drag.stopped, true);
  f.move({ x: 500, y: 10 }); // sky: the corner stays
  f.up({ x: 500, y: 250 });
  assert.equal(f.boxes.length, 1);
  const { west, south, east, north } = f.boxes[0];
  assert.deepEqual(
    [west, south, east, north].map((v) => Math.round(v * 1e6) / 1e6),
    [-97.85, 30.3, -97.8, 30.35],
  );
  assert.deepEqual(f.cancels, []);
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
  assert.equal(f.camera.inputs, true);
  assert.equal(f.captured.size, 0);
  assert.equal(f.previews.at(-1), null, 'the preview goes with the drag');
  assert.equal(f.documentRef.classes.has('gev-imagery-box'), false);
  assert.equal(listenerCount(f), 0);
  assert.deepEqual(f.actives, [true, false]);
  f.tool.destroy();
});

test('presses with a modifier or another button, and moves outside a drag, pass through', () => {
  const f = fixture();
  f.tool.start();
  for (const fields of [{ shiftKey: true }, { ctrlKey: true }, { button: 2 }]) {
    const press = f.down({ x: 250, y: 125 }, fields);
    assert.equal(press.stopped, false, JSON.stringify(fields));
  }
  assert.equal(f.camera.inputs, true);
  assert.equal(f.move({ x: 300, y: 200 }).stopped, false, 'a hover');
  assert.equal(f.tool.isActive(), true);
  f.tool.destroy();
});

test('a sky press, a click without a drag and Escape each say why', () => {
  const f = fixture();
  f.tool.start();
  f.down({ x: 250, y: 10 });
  assert.deepEqual(f.cancels.at(-1), [
    'sky',
    'Press on the ground, not the sky',
  ]);
  assert.equal(f.tool.isActive(), true, 'a sky press keeps the session');
  assert.equal(f.camera.inputs, true, 'and freezes nothing');
  f.down({ x: 250, y: 125 });
  f.up({ x: 250, y: 125 });
  assert.deepEqual(f.cancels.at(-1), ['degenerate', 'Drag to size the box']);
  f.tool.start();
  assert.equal(f.key('Escape').prevented, true);
  assert.deepEqual(f.cancels.at(-1), ['escape', undefined]);
  assert.equal(pointerOwner(), null);
  f.tool.destroy();
});

test('an Escape interceptor that claims the key leaves the tool armed; the next Escape cancels', () => {
  let claim = true;
  let asked = 0;
  const f = fixture({
    onEscape: () => {
      asked += 1;
      return claim;
    },
  });
  f.tool.start();
  const first = f.key('Escape');
  assert.equal(asked, 1);
  assert.equal(
    first.prevented && first.stopped,
    true,
    'the key goes no further',
  );
  assert.equal(f.tool.isActive(), true);
  claim = false;
  f.key('Escape');
  assert.deepEqual(f.cancels, [['escape', undefined]]);
  f.tool.start();
  f.key('Enter');
  assert.equal(asked, 2, 'other keys never reach the interceptor');
  f.tool.destroy();
});

test('a held pointer refuses the session and nothing is bound', () => {
  const f = fixture();
  const lease = claimPointer('draw');
  assert.equal(f.tool.start(), false);
  assert.deepEqual(f.cancels, [
    ['pointer-busy', 'draw is using the pointer — close it first'],
  ]);
  assert.equal(listenerCount(f), 0);
  releasePointer(lease);
  assert.equal(f.tool.start(), true);
  f.tool.destroy();
});

test('destroy mid-drag restores the camera, releases the claim and clears the preview', () => {
  const f = fixture();
  f.tool.start();
  f.down({ x: 250, y: 125 });
  assert.equal(f.camera.inputs, false);
  f.tool.destroy();
  f.tool.destroy();
  assert.equal(f.camera.inputs, true);
  assert.equal(pointerOwner(), null);
  assert.equal(f.previews.at(-1), null);
  assert.equal(listenerCount(f), 0);
  assert.equal(f.tool.start(), false);
  assert.equal(initImageryBoxTool({ engine: null, onBox() {} }), null);
});

test('blur and a cancelled pointer during a drag return the camera, the preview and the pointer', () => {
  const f = fixture();
  f.tool.start();
  f.down({ x: 250, y: 125 });
  assert.equal(f.camera.suspended, 1, "the engine's counted suspension");
  assert.equal(f.camera.choice, true, 'the app choice is left alone');
  f.windowRef.dispatch('blur', {});
  assert.equal(f.camera.suspended, 0);
  assert.equal(f.previews.at(-1), null);
  assert.equal(pointerOwner(), null);
  assert.equal(f.tool.isActive(), false);
  assert.deepEqual(f.cancels.at(-1), ['blur', undefined]);
  f.tool.start();
  f.down({ x: 250, y: 125 });
  f.documentRef.dispatch('pointercancel', { pointerId: 1 });
  assert.equal(f.camera.suspended, 0);
  assert.deepEqual(f.cancels.at(-1), ['pointer-cancel', undefined]);
  assert.equal(listenerCount(f), 0);
  f.tool.destroy();
});
