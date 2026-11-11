// A double-click on the followed track enters first person, and the
// renderer's own double-click follow is held off for that press, so it
// cannot let go of the track first.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fakeInput,
  FakeScreenSpaceEventHandler,
  FAKE_EVENT_TYPES,
} from '../input/testDoubles.mjs';
import { bindRenderer } from '../render/rendererOf.js';
import { entityFollowTarget } from '../data/followed.js';
import { createCesiumInput } from '../render/cesium/input.js';
import { routeSceneDoubleClick, onSceneDoubleClick } from './cockpitInput.js';
import { inputFor } from '../input/dispatcher.js';

function harness(t, { stock = null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const viewer = {
    scene: {
      pick: () => null,
    },
    clock: { currentTime: 0 },
  };
  // The followed aircraft is drawn at (100, 100).
  const project = () => ({ x: 100, y: 100 });
  // With `stock`, the renderer's own input port takes the viewer's stock
  // double-click follow and runs it as the app's does; else the fake input.
  // The camera port follows the aircraft, as the flights layer's follow does.
  const camera = { followed: null, on: () => () => {} };
  const input = stock
    ? cesiumInput(viewer, stock, project, camera)
    : fakeInput(viewer);
  if (!stock) bindRenderer(viewer, { query: { project }, camera });
  const entity = {
    id: 'flights:abc',
    position: { getValue: () => ({ x: 1, y: 2, z: 3 }) },
  };
  camera.followed = entityFollowTarget(entity, {
    position: () => entity.position.getValue(),
    frame: 'enu',
    viewFrom: { x: 0, y: -1000, z: 500 },
  });
  const controller = {
    viewer,
    active: false,
    destroyed: false,
    entered: 0,
    holds: 0,
    // Counted here, unless the test watches the renderer's own hold.
    ...(stock
      ? {}
      : {
          holdStockFollow() {
            this.holds += 1;
            return () => {
              this.holds -= 1;
            };
          },
        }),
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

/** The Cesium renderer's input port over a fake handler, with `follow` as
 * the viewer's stock double-click follow. */
function cesiumInput(viewer, follow, project, camera) {
  const stock = new FakeScreenSpaceEventHandler();
  stock.setInputAction(follow, FAKE_EVENT_TYPES.LEFT_DOUBLE_CLICK);
  viewer.screenSpaceEventHandler = stock;
  viewer.scene.canvas = {
    addEventListener() {},
    removeEventListener() {},
  };
  const handler = new FakeScreenSpaceEventHandler();
  const query = { project, pick: () => null, drillPick: () => [] };
  const made = createCesiumInput(viewer, {
    query,
    createHandler: () => handler,
    report: (error) => {
      throw error;
    },
    document: null,
  });
  bindRenderer(viewer, { input: made.port, query, camera });
  const T = FAKE_EVENT_TYPES;
  const fire = (type) => (position) => handler.fire(type, { position });
  return {
    down: fire(T.LEFT_DOWN),
    up: fire(T.LEFT_UP),
    click: fire(T.LEFT_CLICK),
    tap(position) {
      handler.fire(T.LEFT_DOWN, { position });
      handler.fire(T.LEFT_UP, { position });
      handler.fire(T.LEFT_CLICK, { position });
    },
    dblclick: fire(T.LEFT_DOUBLE_CLICK),
    stockEnabled: (name) => made.port.behaviours[name].enabled,
    destroy: () => made.dispose(),
  };
}

const doubleClick = (input, position) => {
  input.tap(position);
  input.down(position);
  input.up(position);
  input.dblclick(position);
};

test('a double-click on the followed track enters, with the stock follow held off for the press', async (t) => {
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
  // Given back once the double-click's dispatch is over.
  await Promise.resolve();
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

test('a single press on the track gives the stock follow back at its release, or by itself', (t) => {
  const { input, controller } = harness(t);
  input.tap({ x: 100, y: 100 });
  assert.equal(controller.holds, 0, 'given back at the release');
  t.mock.timers.tick(700);
  input.down({ x: 100, y: 100 });
  assert.equal(controller.holds, 1);
  t.mock.timers.tick(700);
  assert.equal(controller.holds, 0, 'a press never released lets go');
  assert.equal(controller.entered, 0);
});

test("a double-click that starts on the track and ends off it is the renderer's own", (t) => {
  const follows = [];
  const { input, controller } = harness(t, {
    stock: (event) => follows.push(event.position),
  });
  const on = { x: 120, y: 100 };
  const off = { x: 140, y: 100 };
  // As Cesium raises them: each press clicks, then the double-click.
  input.tap(on);
  input.tap(off);
  input.dblclick(off);
  assert.equal(controller.entered, 0);
  assert.equal(follows.length, 1, 'the stock follow ran');
  assert.equal(input.stockEnabled('dblclickFollow'), true);
});

test('a press elsewhere just before cannot make a press on the track keep its hold', (t) => {
  const follows = [];
  const { input, controller } = harness(t, {
    stock: (event) => follows.push(event.position),
  });
  input.tap({ x: 500, y: 500 });
  input.tap({ x: 120, y: 100 });
  input.tap({ x: 140, y: 100 });
  input.dblclick({ x: 140, y: 100 });
  assert.equal(controller.entered, 0);
  assert.equal(follows.length, 1, 'the stock follow ran');
});

test('a press on the track long after the last keeps no hold past its release', (t) => {
  const { input, controller } = harness(t);
  const on = { x: 100, y: 100 };
  input.tap(on);
  t.mock.timers.tick(701);
  input.down(on);
  input.up(on);
  assert.equal(controller.holds, 0, 'it cannot end a double-click');
  input.down(on);
  input.up(on);
  assert.equal(controller.holds, 1, 'a quick second press keeps it');
});

test('a double-click that ends on the track holds the stock follow off', async (t) => {
  const follows = [];
  const { input, controller } = harness(t, {
    stock: (event) => follows.push(event.position),
  });
  const on = { x: 110, y: 95 };
  input.tap({ x: 140, y: 100 });
  input.tap(on);
  input.dblclick(on);
  assert.equal(controller.entered, 1);
  assert.deepEqual(follows, [], 'the stock follow did not run');
  await Promise.resolve();
  assert.equal(input.stockEnabled('dblclickFollow'), true, 'given back');
});

test('subscribers after the Cockpit find the stock follow held through the double-click', async (t) => {
  const { input, controller } = harness(t, { stock: () => {} });
  // A layer's own follow on a double-click, subscribed after the Cockpit
  // (Mapped Installations follows a site only while the stock follow runs).
  const seen = [];
  const off = inputFor(controller.viewer).onPointer('dblclick', () =>
    seen.push(input.stockEnabled('dblclickFollow')),
  );
  t.after(off);
  const on = { x: 110, y: 95 };
  input.tap(on);
  input.tap(on);
  input.dblclick(on);
  assert.deepEqual(seen, [false], 'held for the whole dispatch');
  await Promise.resolve();
  assert.equal(input.stockEnabled('dblclickFollow'), true, 'given back after');
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
