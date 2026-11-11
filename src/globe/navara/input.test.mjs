import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavaraInput } from './input.js';

function fakeCanvas() {
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({ left: 100, top: 50 });
  canvas.listenerCount = 0;
  const add = canvas.addEventListener.bind(canvas);
  const remove = canvas.removeEventListener.bind(canvas);
  canvas.addEventListener = (...args) => {
    canvas.listenerCount++;
    add(...args);
  };
  canvas.removeEventListener = (...args) => {
    canvas.listenerCount--;
    remove(...args);
  };
  return canvas;
}

const pointer = (type, x, y, extra = {}) =>
  Object.assign(new Event(type), {
    clientX: x,
    clientY: y,
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    ...extra,
  });

function setup() {
  const canvas = fakeCanvas();
  const cameraOptions = [];
  const view = {
    canvas,
    camera: {
      set options(value) {
        cameraOptions.push(value);
      },
    },
  };
  const { input, destroy } = createNavaraInput(view);
  return { canvas, input, destroy, cameraOptions };
}

test('down, up and click carry canvas-relative positions', () => {
  const { canvas, input } = setup();
  const seen = [];
  for (const type of ['down', 'up', 'click'])
    input.on(type, (event) => seen.push([type, event.position]));
  canvas.dispatchEvent(pointer('pointerdown', 110, 60));
  canvas.dispatchEvent(pointer('pointerup', 113, 61));
  assert.deepEqual(seen, [
    ['down', { x: 10, y: 10 }],
    ['up', { x: 13, y: 11 }],
    ['click', { x: 13, y: 11 }],
  ]);
});

test('a drag beyond the 5 px click tolerance is not a click; other buttons are ignored', () => {
  const { canvas, input } = setup();
  let clicks = 0;
  input.on('click', () => clicks++);
  canvas.dispatchEvent(pointer('pointerdown', 110, 60));
  canvas.dispatchEvent(pointer('pointerup', 120, 60));
  canvas.dispatchEvent(pointer('pointerdown', 110, 60, { button: 2 }));
  canvas.dispatchEvent(pointer('pointerup', 110, 60, { button: 2 }));
  assert.equal(clicks, 0);
});

test('move reports start and end positions; doubleClick a position', () => {
  const { canvas, input } = setup();
  const seen = [];
  input.on('move', (event) => seen.push(event));
  input.on('doubleClick', (event) => seen.push(event));
  canvas.dispatchEvent(pointer('pointermove', 110, 60));
  canvas.dispatchEvent(pointer('pointermove', 115, 70));
  canvas.dispatchEvent(pointer('dblclick', 115, 70));
  assert.deepEqual(seen, [
    { startPosition: { x: 10, y: 10 }, endPosition: { x: 10, y: 10 } },
    { startPosition: { x: 10, y: 10 }, endPosition: { x: 15, y: 20 } },
    { position: { x: 15, y: 20 } },
  ]);
});

test('modifiers: a listener fires only for its own key, an unmodified one only without keys', () => {
  const { canvas, input } = setup();
  const seen = [];
  input.on('down', () => seen.push('none'));
  input.on('down', () => seen.push('shift'), { modifier: 'shift' });
  input.on('down', () => seen.push('ctrl'), { modifier: 'ctrl' });
  canvas.dispatchEvent(pointer('pointerdown', 1, 1));
  canvas.dispatchEvent(pointer('pointerdown', 1, 1, { shiftKey: true }));
  canvas.dispatchEvent(pointer('pointerdown', 1, 1, { ctrlKey: true }));
  // Cesium takes shift over ctrl over alt.
  canvas.dispatchEvent(
    pointer('pointerdown', 1, 1, { ctrlKey: true, shiftKey: true }),
  );
  assert.deepEqual(seen, ['none', 'shift', 'ctrl', 'shift']);
});

test('on validates its arguments and returns an idempotent remover', () => {
  const { canvas, input } = setup();
  assert.throws(() => input.on('wheel', () => {}), TypeError);
  assert.throws(
    () => input.on('click', () => {}, { modifier: 'meta' }),
    TypeError,
  );
  let count = 0;
  const off = input.on('down', () => count++);
  off();
  off();
  canvas.dispatchEvent(pointer('pointerdown', 1, 1));
  assert.equal(count, 0);
});

test("suspending turns Navara's controls off until the resume", () => {
  const { input, cameraOptions } = setup();
  const resume = input.suspendCameraInputs();
  resume();
  assert.deepEqual(cameraOptions, [
    { enableSpin: false, enableZoom: false, enableTilt: false },
    { enableSpin: true, enableZoom: true, enableTilt: true },
  ]);
});

test('suspendCameraInputs counts until the last resume', () => {
  const { input, cameraOptions } = setup();
  const on = { enableSpin: true, enableZoom: true, enableTilt: true };
  const off = { enableSpin: false, enableZoom: false, enableTilt: false };
  assert.equal(input.cameraInputsEnabled(), true);
  const outer = input.suspendCameraInputs();
  const inner = input.suspendCameraInputs();
  assert.equal(input.cameraInputsEnabled(), false);
  inner();
  inner();
  assert.deepEqual(cameraOptions.at(-1), off);
  outer();
  assert.deepEqual(cameraOptions.at(-1), on);
  assert.equal(input.cameraInputsEnabled(), true);
});

test('destroy removes every DOM listener and later subscriptions are inert', () => {
  const { canvas, input, destroy } = setup();
  input.on('click', () => {});
  input.on('move', () => {});
  destroy();
  assert.equal(canvas.listenerCount, 0);
  const off = input.on('click', () => {});
  assert.equal(typeof off, 'function');
  assert.equal(canvas.listenerCount, 0);
});

test('suspension merges into the camera options set through the engine', () => {
  const { input, cameraOptions } = setup();
  input.setCameraOptions({ minimumZoomDistance: 50, zoomSpeed: 2 });
  const resume = input.suspendCameraInputs();
  assert.deepEqual(cameraOptions.at(-1), {
    minimumZoomDistance: 50,
    zoomSpeed: 2,
    enableSpin: false,
    enableZoom: false,
    enableTilt: false,
  });
  input.setCameraOptions({ zoomSpeed: 3 });
  assert.deepEqual(cameraOptions.at(-1), {
    minimumZoomDistance: 50,
    zoomSpeed: 3,
    enableSpin: false,
    enableZoom: false,
    enableTilt: false,
  });
});

test('clicks with pick wait for the click pick; moves with pick use the CPU pick once a frame', async () => {
  const canvas = fakeCanvas();
  const frames = [];
  const calls = [];
  const view = { canvas, camera: { set options(value) {} } };
  const { input } = createNavaraInput(view, {
    picker: {
      clickPick: async (at) => (calls.push(['click', at]), { id: 'gpu' }),
      pick: (at) => (calls.push(['cpu', at]), { id: 'cpu' }),
      drillPick: (at, limit) => (
        calls.push(['drill', limit]),
        [{ id: 'a' }, { id: 'b' }]
      ),
    },
    scheduleFrame: (run) => frames.push(run),
  });
  const seen = [];
  input.on('click', (event) => seen.push(['click', event]), {
    pick: true,
    drill: 1,
  });
  input.on('move', (event) => seen.push(['move', event]), { pick: true });
  canvas.dispatchEvent(pointer('pointerdown', 110, 60));
  canvas.dispatchEvent(pointer('pointerup', 110, 60));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen[0][1].picked, { id: 'gpu' });
  assert.deepEqual(seen[0][1].drilled, [{ id: 'a' }]);
  canvas.dispatchEvent(pointer('pointermove', 120, 70));
  canvas.dispatchEvent(pointer('pointermove', 121, 71));
  assert.equal(frames.length, 1);
  frames[0]();
  assert.deepEqual(seen.at(-1)[1].picked, { id: 'cpu' });
  assert.deepEqual(calls.at(-1), ['cpu', { x: 21, y: 21 }]);
});

test('exclusive pointer drops deferred picks across ownership changes and releases on destroy', async () => {
  const canvas = fakeCanvas();
  const answers = [];
  const { input, destroy } = createNavaraInput(
    { canvas, camera: {} },
    {
      picker: {
        clickPick: () => new Promise((resolve) => answers.push(resolve)),
      },
    },
  );
  const click = () => {
    canvas.dispatchEvent(pointer('pointerdown', 110, 60));
    canvas.dispatchEvent(pointer('pointerup', 110, 60));
  };
  let ambient = 0,
    owned = 0;
  input.on('click', () => ambient++, { pick: true });
  click();
  const claim = input.acquirePointer();
  input.on('click', () => owned++, { pick: true, pointer: claim });
  answers.shift()({ id: 'late' });
  await Promise.resolve();
  assert.equal(ambient, 0);
  click();
  answers.shift()({ id: 'owned' });
  await Promise.resolve();
  assert.equal(owned, 1);
  assert.equal(ambient, 0);
  click();
  claim.release();
  answers.shift()({ id: 'released' });
  await Promise.resolve();
  assert.equal(owned, 1);
  assert.equal(ambient, 0);
  click();
  answers.shift()({ id: 'ambient' });
  await Promise.resolve();
  assert.equal(ambient, 1);
  const next = input.acquirePointer();
  destroy();
  next.release();
  assert.equal(input.acquirePointer(), null);
});

test('custom windows keep down synchronous, moves coalesced and clicks on one GPU gesture', async () => {
  const canvas = fakeCanvas();
  const calls = [],
    seen = [];
  let resolve,
    frame,
    clicks = 0;
  const { input, destroy } = createNavaraInput(
    { canvas, camera: {} },
    {
      picker: {
        pick: (at, w, h) => {
          calls.push(['pick', w, h]);
          return { id: 'cpu' };
        },
        drillPick: (at, limit, w, h) => {
          calls.push(['drill', limit, w, h]);
          return [{ id: 'cpu' }];
        },
        clickPick: () => {
          clicks++;
          return new Promise((done) => {
            resolve = done;
          });
        },
      },
      scheduleFrame: (run) => {
        frame = run;
      },
    },
  );
  const options = { drill: 6, pickWindow: { width: 11, height: 7 } };
  input.on('down', (event) => seen.push(event), options);
  input.on('move', (event) => seen.push(event), options);
  input.on('click', (event) => seen.push(event), options);
  input.on('click', (event) => seen.push(event), { pick: true });
  canvas.dispatchEvent(pointer('pointerdown', 110, 60));
  assert.equal(seen[0].picked.id, 'cpu');
  assert.deepEqual(calls, [
    ['pick', 11, 7],
    ['drill', 6, 11, 7],
  ]);
  canvas.dispatchEvent(pointer('pointermove', 111, 60));
  canvas.dispatchEvent(pointer('pointermove', 112, 60));
  assert.equal(seen.length, 1);
  frame();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].endPosition.x, 12);
  canvas.dispatchEvent(pointer('pointerup', 112, 60));
  assert.equal(clicks, 1);
  assert.equal(seen.length, 2);
  resolve({ id: 'gpu' });
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(
    seen.slice(2).map((event) => event.picked.id),
    ['gpu', 'gpu'],
  );
  destroy();
});

test('a pinch whose still finger lifts first is not a click', async () => {
  const { canvas, input, destroy } = setup();
  let clicks = 0;
  input.on('click', () => clicks++);
  const touch = (type, id, x, y) =>
    pointer(type, x, y, {
      pointerId: id,
      pointerType: 'touch',
      isPrimary: id === 1,
    });
  canvas.dispatchEvent(touch('pointerdown', 1, 100, 300));
  canvas.dispatchEvent(touch('pointerdown', 2, 300, 300));
  // Only the first finger moves (a one-sided pinch).
  for (let i = 1; i <= 5; i++)
    canvas.dispatchEvent(touch('pointermove', 1, 100 - 20 * i, 300));
  canvas.dispatchEvent(touch('pointerup', 2, 300, 300));
  canvas.dispatchEvent(touch('pointerup', 1, 0, 300));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clicks, 0);
  canvas.dispatchEvent(touch('pointerdown', 1, 100, 300));
  canvas.dispatchEvent(touch('pointercancel', 1, 100, 300));
  canvas.dispatchEvent(touch('pointerup', 1, 100, 300));
  await Promise.resolve();
  assert.equal(clicks, 0, 'a cancelled pointer cannot click');
  canvas.dispatchEvent(touch('pointerdown', 1, 100, 300));
  canvas.dispatchEvent(touch('pointerup', 1, 100, 300));
  await Promise.resolve();
  assert.equal(clicks, 1, 'the next single tap still clicks');
  destroy();
});

test('a mouse released off the canvas does not hold back the next tap', async () => {
  const { canvas, input, destroy } = setup();
  let clicks = 0;
  input.on('click', () => clicks++);
  // The mouse goes down on the globe and up outside it.
  canvas.dispatchEvent(
    pointer('pointerdown', 100, 300, { pointerId: 1, isPrimary: true }),
  );
  canvas.dispatchEvent(
    pointer('pointerdown', 100, 300, {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
    }),
  );
  canvas.dispatchEvent(
    pointer('pointerup', 100, 300, {
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
    }),
  );
  await Promise.resolve();
  assert.equal(clicks, 1);
  destroy();
});
