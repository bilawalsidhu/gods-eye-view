import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installContextLossGuard,
  showContextLossNotice,
  canReloadAfterContextLoss,
  markContextLossReload,
} from './contextLoss.js';

/** A Cesium-style event: addEventListener returns the remover. */
function createEvent() {
  const listeners = new Set();
  return {
    addEventListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    raise(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function createFakeViewer({ contextLost = () => false } = {}) {
  const canvas = new EventTarget();
  canvas.getContext = () => ({ isContextLost: contextLost });
  return {
    canvas,
    scene: { renderError: createEvent() },
    useDefaultRenderLoop: true,
    isDestroyed: () => false,
  };
}

function createFakeDocument() {
  const byId = new Map();
  const create = (tag) => ({
    tag,
    id: '',
    style: {},
    attrs: {},
    children: [],
    listeners: {},
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    },
    click() {
      for (const listener of this.listeners.click ?? []) listener();
    },
    querySelector(selector) {
      return this.children.find((child) => child.tag === selector) ?? null;
    },
  });
  return {
    body: {
      appendChild: (element) => byId.set(element.id, element),
    },
    getElementById: (id) => byId.get(id) ?? null,
    createElement: create,
  };
}

function createFakeStorage({ throwOnAccess = false } = {}) {
  const store = new Map();
  return {
    getItem: (key) => {
      if (throwOnAccess) throw new Error('storage refused');
      return store.has(key) ? store.get(key) : null;
    },
    setItem: (key, value) => {
      if (throwOnAccess) throw new Error('storage refused');
      store.set(key, String(value));
    },
  };
}

test('webglcontextlost preventDefaults, stops the render loop and reports the loss once', () => {
  const viewer = createFakeViewer();
  const losses = [];
  const disposer = installContextLossGuard(viewer, {
    onLost: (details) => losses.push(details),
  });
  const event = new Event('webglcontextlost', { cancelable: true });
  viewer.canvas.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(viewer.useDefaultRenderLoop, false);
  assert.deepEqual(losses, [{ reason: 'event' }]);
  // The guard keeps working after the loss (stop-loop on any later signal)
  // but the embedder's onLost must not fire twice for one loss.
  viewer.canvas.dispatchEvent(
    new Event('webglcontextlost', { cancelable: true }),
  );
  assert.equal(losses.length, 1);
  disposer();
});

test('a render error while the context is lost counts as the loss', () => {
  const viewer = createFakeViewer({ contextLost: () => true });
  const losses = [];
  installContextLossGuard(viewer, {
    onLost: (details) => losses.push(details),
  });
  const error = new Error('Expected width to be greater than 0');
  viewer.scene.renderError.raise(viewer.scene, error);
  assert.equal(viewer.useDefaultRenderLoop, false);
  assert.deepEqual(losses, [{ reason: 'render-error', error }]);
});

test('a render error with an intact context is not a loss', () => {
  const viewer = createFakeViewer({ contextLost: () => false });
  const losses = [];
  installContextLossGuard(viewer, { onLost: (details) => losses.push(details) });
  viewer.scene.renderError.raise(viewer.scene, new Error('shader link failed'));
  assert.equal(viewer.useDefaultRenderLoop, true);
  assert.deepEqual(losses, []);
});

test('restored resets the loss so a later loss reports again', () => {
  const viewer = createFakeViewer();
  const losses = [];
  const restores = [];
  installContextLossGuard(viewer, {
    onLost: (details) => losses.push(details),
    onRestored: () => restores.push(true),
  });
  viewer.canvas.dispatchEvent(
    new Event('webglcontextlost', { cancelable: true }),
  );
  viewer.canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(restores.length, 1);
  viewer.canvas.dispatchEvent(
    new Event('webglcontextlost', { cancelable: true }),
  );
  assert.equal(losses.length, 2);
});

test('the disposer removes every listener the guard installed', () => {
  const viewer = createFakeViewer({ contextLost: () => true });
  const losses = [];
  const restores = [];
  const disposer = installContextLossGuard(viewer, {
    onLost: (details) => losses.push(details),
    onRestored: () => restores.push(true),
  });
  disposer();
  viewer.canvas.dispatchEvent(
    new Event('webglcontextlost', { cancelable: true }),
  );
  viewer.canvas.dispatchEvent(new Event('webglcontextrestored'));
  viewer.scene.renderError.raise(viewer.scene, new Error('gone'));
  assert.equal(viewer.useDefaultRenderLoop, true);
  assert.deepEqual(losses, []);
  assert.deepEqual(restores, []);
});

test('recovery reload is allowed without a flag and blocked inside the cooldown', () => {
  const storage = createFakeStorage();
  let now = 1_000_000;
  assert.equal(canReloadAfterContextLoss({ sessionStorage: storage, now: () => now }), true);
  markContextLossReload({ sessionStorage: storage, now: () => now });
  // Within the window: blocked.
  now += 1_000;
  assert.equal(canReloadAfterContextLoss({ sessionStorage: storage, now: () => now }), false);
  // After the window: allowed again.
  now += 31_000;
  assert.equal(canReloadAfterContextLoss({ sessionStorage: storage, now: () => now }), true);
});

test('refused web storage never auto-reloads', () => {
  const storage = createFakeStorage({ throwOnAccess: true });
  assert.equal(
    canReloadAfterContextLoss({ sessionStorage: storage, now: () => 0 }),
    false,
  );
});

test('the notice is idempotent and only the terminal case offers reload', () => {
  const documentRef = createFakeDocument();
  const location = { reload: () => {} };
  const first = showContextLossNotice({ document: documentRef, location });
  assert.notEqual(first, null);
  assert.equal(first.attrs.role, 'alert');
  assert.equal(first.querySelector('span').textContent.includes('3D graphics context'), true);
  assert.equal(first.querySelector('button'), null);
  // A second loss reuses the element instead of stacking notices.
  const again = showContextLossNotice({ document: documentRef, location });
  assert.equal(again, first);
  // The standalone terminal case adds the manual way out.
  showContextLossNotice({
    document: documentRef,
    location,
    allowManualReload: true,
  });
  const button = first.querySelector('button');
  assert.notEqual(button, null);
  let reloaded = 0;
  location.reload = () => reloaded++;
  button.click();
  assert.equal(reloaded, 1);
});

test('the notice returns null without a document (workers, tests)', () => {
  assert.equal(showContextLossNotice({ document: null }), null);
});
