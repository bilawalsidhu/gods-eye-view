import test from 'node:test';
import assert from 'node:assert/strict';
import { createImagerySplit } from './imagerySplit.js';

/** The handle the view renders: a pointer capture target. */
function fakeHandle() {
  return {
    captured: [],
    released: [],
    setPointerCapture(id) {
      this.captured.push(id);
    },
    releasePointerCapture(id) {
      this.released.push(id);
    },
  };
}

/** The imagery split store as the split sees it. */
function fakeStore() {
  const lines = new Map();
  return {
    lines,
    publish(key, view, controls) {
      lines.set(key, { view, controls });
    },
    withdraw(key) {
      lines.delete(key);
    },
  };
}

function fixture({ initialValue = 0.5, splitPosition = 0.37 } = {}) {
  const cssCalls = [];
  const changes = [];
  let renders = 0;
  const scene = { splitPosition };
  const cssTarget = {
    style: {
      setProperty(name, value) {
        cssCalls.push(['set', name, value]);
      },
      removeProperty(name) {
        cssCalls.push(['remove', name]);
      },
    },
  };
  const store = fakeStore();
  const split = createImagerySplit({
    scene,
    initialValue,
    id: 'split-line',
    handleClass: 'split-handle',
    cssTarget,
    cssProperty: '--split',
    beforeTitle: 'Before',
    afterTitle: 'After',
    ariaLabel: 'Divider',
    getViewportWidth: () => 1000,
    onChange: (value) => changes.push(value),
    requestRender: () => {
      renders += 1;
    },
    store,
  });
  const [key] = store.lines.keys();
  const line = () => store.lines.get(key) ?? null;
  const handle = fakeHandle();
  // The view's handle dispatching to the split, as Vue's listeners do.
  const dispatch = (type, event = {}) =>
    line()?.controls[type === 'pointercancel' ? 'pointerup' : type]({
      currentTarget: handle,
      ...event,
    });
  return {
    split,
    scene,
    store,
    line,
    view: () => line()?.view,
    handle,
    dispatch,
    cssCalls,
    changes,
    renders: () => renders,
  };
}

test('the split publishes its line and applies the initial value without notifying', () => {
  const env = fixture({ initialValue: 0.62 });
  assert.deepEqual(env.view(), {
    id: 'split-line',
    hidden: false,
    handleClass: 'split-handle',
    beforeLabel: 'A',
    afterLabel: 'B',
    beforeTitle: 'Before',
    afterTitle: 'After',
    ariaLabel: 'Divider',
    valueNow: 62,
    valueText: 'A 62 percent, B 38 percent',
  });
  assert.equal(env.scene.splitPosition, 0.62);
  assert.deepEqual(env.cssCalls, [['set', '--split', '62%']]);
  assert.deepEqual(env.changes, []);
  assert.equal(env.renders(), 0);
  assert.equal(env.split.getValue(), 0.62);
});

test('keyboard steps 1 percent, 5 percent with Shift, and jumps to Home and End', () => {
  const env = fixture();
  const key = (key, shiftKey = false) => {
    let prevented = false;
    env.dispatch('keydown', {
      key,
      shiftKey,
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };
  assert.equal(key('ArrowRight'), true);
  assert.equal(env.scene.splitPosition, 0.51);
  assert.equal(key('ArrowLeft', true), true);
  assert.equal(env.scene.splitPosition, 0.46);
  assert.equal(key('Home'), true);
  assert.equal(env.scene.splitPosition, 0);
  assert.equal(env.view().valueNow, 0);
  assert.equal(key('End'), true);
  assert.equal(env.scene.splitPosition, 1);
  assert.equal(env.view().valueNow, 100);
  assert.equal(key('Enter'), false, 'other keys are ignored and not prevented');
  assert.equal(env.scene.splitPosition, 1);
  assert.deepEqual(env.changes, [0.51, 0.46, 0, 1]);
});

test('values clamp to the unit range and only real changes notify or render', () => {
  const env = fixture();
  assert.equal(env.split.setValue(1.4), true);
  assert.equal(env.split.getValue(), 1);
  assert.equal(env.scene.splitPosition, 1);
  assert.equal(env.split.setValue(1), false);
  assert.equal(env.split.setValue(-3), true);
  assert.equal(env.split.getValue(), 0);
  assert.equal(
    env.split.setValue('nonsense'),
    false,
    'non-numeric input clamps to 0',
  );
  assert.equal(env.renders(), 2, 'render only when the clamped value moved');
  assert.deepEqual(
    env.changes,
    [],
    'setValue is the owner writing; it never echoes',
  );
  env.dispatch('keydown', { key: 'Home', preventDefault() {} });
  env.dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(
    env.changes,
    [],
    'interaction that cannot move the value stays silent',
  );
  env.dispatch('keydown', { key: 'End', preventDefault() {} });
  env.dispatch('keydown', { key: 'End', preventDefault() {} });
  assert.deepEqual(env.changes, [1]);
  assert.equal(env.renders(), 3);
  assert.deepEqual(env.cssCalls, [
    ['set', '--split', '50%'],
    ['set', '--split', '100%'],
    ['set', '--split', '0%'],
    ['set', '--split', '100%'],
  ]);
});

test('pointer drags follow the primary pointer only', () => {
  const env = fixture();
  env.dispatch('pointerdown', {
    button: 2,
    clientX: 900,
    pointerId: 1,
    preventDefault() {},
  });
  assert.equal(
    env.scene.splitPosition,
    0.5,
    'non-primary buttons never start a drag',
  );
  env.dispatch('pointermove', {
    clientX: 900,
    pointerId: 1,
    preventDefault() {},
  });
  assert.equal(
    env.scene.splitPosition,
    0.5,
    'moves without a drag are ignored',
  );
  env.dispatch('pointerdown', {
    button: 0,
    clientX: 250,
    pointerId: 4,
    preventDefault() {},
  });
  assert.equal(env.scene.splitPosition, 0.25);
  assert.deepEqual(env.handle.captured, [4]);
  env.dispatch('pointermove', {
    clientX: 900,
    pointerId: 9,
    preventDefault() {},
  });
  assert.equal(
    env.scene.splitPosition,
    0.25,
    'a different pointer id is ignored',
  );
  env.dispatch('pointerup', { pointerId: 9 });
  env.dispatch('pointermove', {
    clientX: 750,
    pointerId: 4,
    preventDefault() {},
  });
  assert.equal(
    env.scene.splitPosition,
    0.75,
    'the drag survives a foreign pointerup',
  );
  env.dispatch('pointermove', {
    clientX: Number.NaN,
    pointerId: 4,
    preventDefault() {},
  });
  assert.equal(
    env.scene.splitPosition,
    0.75,
    'unusable coordinates are ignored',
  );
  env.dispatch('pointerup', { pointerId: 4 });
  assert.deepEqual(env.handle.released, [4]);
  env.dispatch('pointermove', {
    clientX: 100,
    pointerId: 4,
    preventDefault() {},
  });
  assert.equal(env.scene.splitPosition, 0.75, 'the drag ended');
  assert.deepEqual(env.changes, [0.25, 0.75]);
});

test('visibility toggles the line without touching the value', () => {
  const env = fixture();
  env.split.setVisible(false);
  assert.equal(env.view().hidden, true);
  env.split.setVisible(true);
  assert.equal(env.view().hidden, false);
  assert.equal(env.split.getValue(), 0.5);
});

test('destroy withdraws the line, clears the CSS property, restores the scene split once, and is idempotent', () => {
  const env = fixture({ initialValue: 0.8, splitPosition: 0.37 });
  env.dispatch('pointerdown', {
    button: 0,
    clientX: 100,
    pointerId: 2,
    preventDefault() {},
  });
  assert.equal(env.scene.splitPosition, 0.1);
  const { controls } = env.line();
  env.split.destroy();
  assert.equal(env.line(), null);
  assert.deepEqual(
    env.handle.released,
    [2],
    'an in-flight drag releases its capture',
  );
  assert.equal(env.cssCalls.at(-1)[0], 'remove');
  assert.equal(env.scene.splitPosition, 0.37);
  env.scene.splitPosition = 0.9;
  env.split.destroy();
  assert.equal(
    env.scene.splitPosition,
    0.9,
    'a second destroy does not restore again',
  );
  assert.equal(env.cssCalls.filter(([kind]) => kind === 'remove').length, 1);
  assert.equal(
    env.split.setValue(0.2),
    false,
    'a destroyed split ignores writes',
  );
  assert.equal(env.scene.splitPosition, 0.9);
  controls.keydown({ key: 'End', preventDefault() {} });
  controls.pointerdown({ button: 0, clientX: 900, pointerId: 3 });
  assert.deepEqual(env.changes, [0.1], 'its controls are inert');
  assert.equal(env.store.lines.size, 0, 'nothing republishes the line');
});
