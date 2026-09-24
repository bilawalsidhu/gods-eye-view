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
  const tool = initImageryBoxTool({
    viewer: fakes.viewer,
    cesium: fakes.cesium,
    pickWorld: fakes.pickWorld,
    documentRef: fakes.documentRef,
    onBox: (box) => boxes.push(box),
    onCancel: (reason, message) => cancels.push([reason, message]),
    onActive: (active) => actives.push(active),
    ...options,
  });
  const camera = fakes.viewer.scene.screenSpaceCameraController;
  const stockAction = (type) =>
    fakes.viewer.screenSpaceEventHandler.getInputAction(fakes.types[type]);
  const preview = () =>
    fakes.viewer.dataSources.sources[0]?.entities.values.every((e) => e.show);
  return {
    ...fakes,
    tool,
    boxes,
    cancels,
    actives,
    camera,
    stockAction,
    preview,
  };
}

test('a session claims the pointer, borrows the stock clicks, freezes the camera only mid-drag and returns everything with the box', async () => {
  const f = fixture();
  assert.equal(f.tool.start(), true);
  assert.equal(pointerOwner(), IMAGERY_BOX_POINTER_OWNER);
  assert.equal(f.stockAction('LEFT_CLICK'), undefined);
  assert.equal(f.stockAction('LEFT_DOUBLE_CLICK'), undefined);
  assert.ok(f.documentRef.classes.has('gev-imagery-box'));
  assert.equal(f.camera.enableInputs, true, 'not frozen before the press');
  f.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  assert.equal(f.camera.enableInputs, false);
  assert.equal(f.preview(), true);
  f.fire('MOUSE_MOVE', { endPosition: { x: 500, y: 250 } });
  f.fire('MOUSE_MOVE', { endPosition: { x: 500, y: 10 } }); // sky: ignored
  f.fire('LEFT_UP', { position: { x: 500, y: 250 } });
  assert.equal(f.boxes.length, 1);
  const { west, south, east, north } = f.boxes[0];
  assert.deepEqual(
    [west, south, east, north].map((v) => Math.round(v * 1e6) / 1e6),
    [-97.85, 30.3, -97.8, 30.35],
  );
  assert.deepEqual(f.cancels, []);
  assert.equal(f.tool.isActive(), false);
  assert.equal(pointerOwner(), null);
  assert.equal(f.stockAction('LEFT_CLICK'), f.originalClick);
  assert.equal(f.stockAction('LEFT_DOUBLE_CLICK'), f.originalDouble);
  assert.equal(f.camera.enableInputs, true);
  assert.equal(f.preview(), false);
  assert.equal(f.documentRef.classes.has('gev-imagery-box'), false);
  assert.equal(f.documentRef.listeners.length, 0);
  assert.equal(f.handler(), null);
  assert.deepEqual(f.actives, [true, false]);
  await f.tool.destroy();
});

test('a sky press, a click without a drag and Escape each say why', async () => {
  const f = fixture();
  f.tool.start();
  f.fire('LEFT_DOWN', { position: { x: 250, y: 10 } });
  assert.deepEqual(f.cancels.at(-1), [
    'sky',
    'Press on the ground, not the sky',
  ]);
  assert.equal(f.tool.isActive(), true, 'a sky press keeps the session');
  f.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  f.fire('LEFT_UP', { position: { x: 250, y: 125 } });
  assert.deepEqual(f.cancels.at(-1), ['degenerate', 'Drag to size the box']);
  f.tool.start();
  assert.equal(f.key('Escape').prevented, true);
  assert.deepEqual(f.cancels.at(-1), ['escape', undefined]);
  assert.equal(pointerOwner(), null);
  await f.tool.destroy();
});

test('an Escape interceptor that claims the key leaves the tool armed; the next Escape cancels', async () => {
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
  await f.tool.destroy();
});

test('a held pointer refuses the session and nothing is borrowed', async () => {
  const f = fixture();
  const lease = claimPointer('draw');
  assert.equal(f.tool.start(), false);
  assert.deepEqual(f.cancels, [
    ['pointer-busy', 'draw is using the pointer — close it first'],
  ]);
  assert.equal(f.stockAction('LEFT_CLICK'), f.originalClick);
  assert.equal(f.handler(), null);
  releasePointer(lease);
  assert.equal(f.tool.start(), true);
  await f.tool.destroy();
});

test('destroy mid-drag restores the camera, releases the claim and detaches the preview', async () => {
  const f = fixture();
  f.tool.start();
  f.fire('LEFT_DOWN', { position: { x: 250, y: 125 } });
  assert.equal(f.viewer.dataSources.sources.length, 1);
  await f.tool.destroy();
  assert.equal(f.camera.enableInputs, true);
  assert.equal(pointerOwner(), null);
  assert.equal(f.viewer.dataSources.sources.length, 0);
  assert.equal(f.stockAction('LEFT_CLICK'), f.originalClick);
  assert.equal(f.tool.start(), false);
  assert.equal(initImageryBoxTool({ viewer: null, onBox() {} }), null);
});
