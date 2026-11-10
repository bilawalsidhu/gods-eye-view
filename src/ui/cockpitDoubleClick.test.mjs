// A double-click on the followed track enters first person, and the
// renderer's own double-click follow is held off for that press, so it
// cannot let go of the track first.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeInput } from '../input/testDoubles.mjs';
import { bindRenderer } from '../render/rendererOf.js';
import { routeSceneDoubleClick, onSceneDoubleClick } from './cockpitInput.js';

function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const viewer = {
    scene: {
      pick: () => null,
    },
    clock: { currentTime: 0 },
  };
  const input = fakeInput(viewer);
  // The followed aircraft is drawn at (100, 100).
  bindRenderer(viewer, { query: { project: () => ({ x: 100, y: 100 }) } });
  const entity = {
    id: 'flights:abc',
    position: { getValue: () => ({ x: 1, y: 2, z: 3 }) },
  };
  viewer.trackedEntity = entity;
  const controller = {
    viewer,
    active: false,
    destroyed: false,
    entered: 0,
    holds: 0,
    holdStockFollow() {
      this.holds += 1;
      return () => {
        this.holds -= 1;
      };
    },
    resolveEntryKind: () => 'aircraft',
    enter() {
      this.entered += 1;
    },
    onSceneDoubleClick(position) {
      return onSceneDoubleClick.call(this, position);
    },
  };
  const stop = routeSceneDoubleClick.call(controller);
  t.after(() => {
    stop();
    input.destroy();
  });
  return { input, controller, stop };
}

const doubleClick = (input, position) => {
  input.tap(position);
  input.down(position);
  input.up(position);
  input.dblclick(position);
};

test('a double-click on the followed track enters, with the stock follow held off for the press', (t) => {
  const { input, controller } = harness(t);
  const on = { x: 110, y: 95 };
  input.down(on);
  assert.equal(
    input.stockEnabled('dblclickFollow'),
    false,
    'held at the press',
  );
  input.up(on);
  input.click(on);
  input.down(on);
  input.up(on);
  input.dblclick(on);
  assert.equal(controller.entered, 1);
  assert.equal(controller.holds, 0, 'given back');
});

test("a double-click elsewhere is the renderer's own", (t) => {
  const { input, controller } = harness(t);
  const off = { x: 400, y: 300 };
  input.down(off);
  assert.equal(controller.holds, 0);
  doubleClick(input, off);
  assert.equal(controller.entered, 0);
  assert.equal(controller.holds, 0);
});

test('a single press on the track gives the stock follow back by itself', (t) => {
  const { input, controller } = harness(t);
  input.tap({ x: 100, y: 100 });
  assert.equal(controller.holds, 1);
  t.mock.timers.tick(700);
  assert.equal(controller.holds, 0);
  assert.equal(controller.entered, 0);
});

test('an active Cockpit leaves presses alone, and stopping lets a hold go', (t) => {
  const { input, controller, stop } = harness(t);
  controller.active = true;
  input.down({ x: 100, y: 100 });
  assert.equal(controller.holds, 0);
  controller.active = false;
  input.down({ x: 100, y: 100 });
  assert.equal(controller.holds, 1);
  stop();
  assert.equal(controller.holds, 0);
});
