import test from 'node:test';
import assert from 'node:assert/strict';
import { createImagerySplit } from './imagerySplit.js';

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.removed = false;
    this.captured = [];
    this.released = [];
    this._attributes = new Map();
    this._listeners = new Map();
  }
  setAttribute(name, value) {
    this._attributes.set(name, value);
  }
  getAttribute(name) {
    return this._attributes.get(name) ?? null;
  }
  addEventListener(type, handler) {
    this._listeners.set(type, handler);
  }
  removeEventListener(type, handler) {
    if (this._listeners.get(type) === handler) this._listeners.delete(type);
  }
  dispatch(type, event = {}) {
    return this._listeners.get(type)?.(event);
  }
  setPointerCapture(id) {
    this.captured.push(id);
  }
  releasePointerCapture(id) {
    this.released.push(id);
  }
  append(...children) {
    this.children.push(...children);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  remove() {
    this.removed = true;
  }
}

function fixture({ initialValue = 0.5, splitPosition = 0.37 } = {}) {
  const body = new FakeElement('body');
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
  const previous = globalThis.document;
  globalThis.document = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    documentElement: cssTarget,
  };
  const split = createImagerySplit({
    scene,
    parent: body,
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
  });
  globalThis.document = previous;
  const line = body.children[0];
  const handle = line.children.find((child) => child.tagName === 'button');
  return {
    split,
    scene,
    body,
    line,
    handle,
    cssCalls,
    changes,
    renders: () => renders,
  };
}

test('the split builds its line and applies the initial value without notifying', () => {
  const env = fixture({ initialValue: 0.62 });
  assert.equal(env.line.id, 'split-line');
  assert.equal(env.line.children[0].textContent, 'A');
  assert.equal(env.line.children[0].title, 'Before');
  assert.equal(env.line.children[2].textContent, 'B');
  assert.equal(env.line.children[2].title, 'After');
  assert.equal(env.handle.className, 'split-handle');
  assert.equal(env.handle.getAttribute('role'), 'slider');
  assert.equal(env.handle.getAttribute('aria-label'), 'Divider');
  assert.equal(env.handle.getAttribute('aria-valuenow'), '62');
  assert.equal(
    env.handle.getAttribute('aria-valuetext'),
    'A 62 percent, B 38 percent',
  );
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
    env.handle.dispatch('keydown', {
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
  assert.equal(env.handle.getAttribute('aria-valuenow'), '0');
  assert.equal(key('End'), true);
  assert.equal(env.scene.splitPosition, 1);
  assert.equal(env.handle.getAttribute('aria-valuenow'), '100');
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
  env.handle.dispatch('keydown', { key: 'Home', preventDefault() {} });
  env.handle.dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.deepEqual(
    env.changes,
    [],
    'interaction that cannot move the value stays silent',
  );
  env.handle.dispatch('keydown', { key: 'End', preventDefault() {} });
  env.handle.dispatch('keydown', { key: 'End', preventDefault() {} });
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
  env.handle.dispatch('pointerdown', {
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
  env.handle.dispatch('pointermove', {
    clientX: 900,
    pointerId: 1,
    preventDefault() {},
  });
  assert.equal(
    env.scene.splitPosition,
    0.5,
    'moves without a drag are ignored',
  );
  env.handle.dispatch('pointerdown', {
    button: 0,
    clientX: 250,
    pointerId: 4,
    preventDefault() {},
  });
  assert.equal(env.scene.splitPosition, 0.25);
  assert.deepEqual(env.handle.captured, [4]);
  env.handle.dispatch('pointermove', {
    clientX: 900,
    pointerId: 9,
    preventDefault() {},
  });
  assert.equal(
    env.scene.splitPosition,
    0.25,
    'a different pointer id is ignored',
  );
  env.handle.dispatch('pointerup', { pointerId: 9 });
  env.handle.dispatch('pointermove', {
    clientX: 750,
    pointerId: 4,
    preventDefault() {},
  });
  assert.equal(
    env.scene.splitPosition,
    0.75,
    'the drag survives a foreign pointerup',
  );
  env.handle.dispatch('pointermove', {
    clientX: Number.NaN,
    pointerId: 4,
    preventDefault() {},
  });
  assert.equal(
    env.scene.splitPosition,
    0.75,
    'unusable coordinates are ignored',
  );
  env.handle.dispatch('pointerup', { pointerId: 4 });
  assert.deepEqual(env.handle.released, [4]);
  env.handle.dispatch('pointermove', {
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
  assert.equal(env.line.hidden, true);
  env.split.setVisible(true);
  assert.equal(env.line.hidden, false);
  assert.equal(env.split.getValue(), 0.5);
});

test('destroy removes the line, clears the CSS property, restores the scene split once, and is idempotent', () => {
  const env = fixture({ initialValue: 0.8, splitPosition: 0.37 });
  env.handle.dispatch('pointerdown', {
    button: 0,
    clientX: 100,
    pointerId: 2,
    preventDefault() {},
  });
  assert.equal(env.scene.splitPosition, 0.1);
  env.split.destroy();
  assert.equal(env.line.removed, true);
  assert.deepEqual(
    env.handle.released,
    [2],
    'an in-flight drag releases its capture',
  );
  assert.equal(env.cssCalls.at(-1)[0], 'remove');
  assert.equal(env.scene.splitPosition, 0.37);
  assert.equal(env.handle._listeners.size, 0);
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
  env.handle.dispatch('keydown', { key: 'End', preventDefault() {} });
  assert.deepEqual(env.changes, [0.1], 'listeners are gone');
});
