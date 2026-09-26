import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimPointer,
  isPointerFree,
  pointerOwner,
  releasePointer,
  resetPointerOwnership,
} from '../data/inputOwnership.js';
import { createStreetView } from './streetView.js';

function fixture({ apiKey = 'test-key' } = {}) {
  resetPointerOwnership();
  const handlers = [];
  const Cesium = {
    ScreenSpaceEventType: { LEFT_CLICK: 'LEFT_CLICK' },
    ScreenSpaceEventHandler: class {
      constructor() {
        this.destroyed = false;
        handlers.push(this);
      }
      setInputAction(action) {
        this.action = action;
      }
      destroy() {
        this.destroyed = true;
      }
    },
    defined: (value) => value !== undefined && value !== null,
  };
  const classes = new Set();
  const canvas = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };
  const viewer = {
    scene: { canvas, requestRender() {} },
    entities: { removeById() {} },
    isDestroyed: () => false,
  };
  const keyListeners = new Set();
  const documentRef = {
    addEventListener: (type, listener) => {
      if (type === 'keydown') keyListeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === 'keydown') keyListeners.delete(listener);
    },
  };
  const toasts = [];
  const streetView = createStreetView({
    viewer,
    Cesium,
    documentRef,
    getApiKey: () => apiKey,
    showToast: (message) => toasts.push(message),
  });
  const press = (key) => {
    for (const listener of [...keyListeners]) listener({ key });
  };
  return { streetView, handlers, classes, keyListeners, toasts, press };
}

test('arming takes the pointer and shows the pick cursor', () => {
  const f = fixture();
  assert.equal(f.streetView.toggle(), true);
  assert.equal(pointerOwner(), 'street-view');
  assert.ok(f.classes.has('street-view-armed'));
  assert.match(f.toasts.at(-1), /Click a street/);
  f.streetView.destroy();
});

test('pressing the shortcut again or Escape gives the pointer back', () => {
  const f = fixture();
  f.streetView.toggle();
  f.streetView.toggle();
  assert.ok(isPointerFree());
  assert.ok(!f.classes.has('street-view-armed'));
  f.streetView.toggle();
  f.press('Escape');
  assert.ok(isPointerFree());
  f.streetView.destroy();
});

test('without a Google key nothing is armed and the toast says why', () => {
  const f = fixture({ apiKey: '  ' });
  assert.equal(f.streetView.toggle(), false);
  assert.ok(isPointerFree());
  assert.match(f.toasts.at(-1), /needs a Google Maps key/);
  f.streetView.destroy();
});

test('another tool holding the pointer blocks arming instead of stealing it', () => {
  const f = fixture();
  const lease = claimPointer('draw');
  assert.equal(f.streetView.toggle(), false);
  assert.equal(pointerOwner(), 'draw');
  assert.match(f.toasts.at(-1), /Finish draw first/);
  releasePointer(lease);
  f.streetView.destroy();
});

test('destroy releases the pointer, the click handler and the key listener', () => {
  const f = fixture();
  f.streetView.toggle();
  f.streetView.destroy();
  assert.ok(isPointerFree());
  assert.ok(f.handlers.every((handler) => handler.destroyed));
  assert.equal(f.keyListeners.size, 0);
  assert.equal(f.streetView.toggle(), false);
});
