import assert from 'node:assert/strict';
import test from 'node:test';

import { ShareRestoration } from './shareRestoration.js';

function installBrowserGlobals(t) {
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    CustomEvent: globalThis.CustomEvent,
  };
  let frameId = 0;
  globalThis.window = new EventTarget();
  globalThis.document = { getElementById: () => null };
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++frameId;
    queueMicrotask(() => callback(0));
    return id;
  };
  globalThis.cancelAnimationFrame = () => {};
  if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent extends Event {
      constructor(type, options = {}) {
        super(type);
        this.detail = options.detail;
      }
    };
  }
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
}

function createOwner(savedState, notices) {
  const owner = new ShareRestoration({
    viewer: { canvas: new EventTarget() },
    navigation: {
      _beginDeferredNavigation: () => 1,
      _stampNavigation() {},
    },
    syncShareState() {},
    syncModels3d() {},
    showStatus: (message) => notices.push(message),
    feedback: {},
    updateFeedback() {},
  });
  owner.attachLinks({
    parseInitialHash: () => savedState,
  });
  return owner;
}

async function flushDeferredNotice() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('defers invalid-layer notice until startup settles', async (t) => {
  installBrowserGlobals(t);
  const notices = [];
  const owner = createOwner(
    { latitude: 30, longitude: -97, layerStateInvalid: true },
    notices,
  );

  owner.start();
  assert.deepEqual(notices, []);

  owner._settleInitialShareRestore({
    status: 'settled',
    share: { camera: 'skipped' },
    layers: [],
  });
  await flushDeferredNotice();

  assert.deepEqual(notices, ['Shared layer selection could not be restored']);
  owner.destroy();
});

test('valid layers stay quiet and disposal suppresses notice', async (t) => {
  installBrowserGlobals(t);

  const validNotices = [];
  const valid = createOwner(
    { latitude: 30, longitude: -97, layerStateInvalid: false },
    validNotices,
  );
  valid.start();
  valid._settleInitialShareRestore({
    status: 'settled',
    share: { camera: 'skipped' },
    layers: [],
  });
  await flushDeferredNotice();
  assert.deepEqual(validNotices, []);
  valid.destroy();

  const disposedNotices = [];
  const disposed = createOwner(
    { latitude: 30, longitude: -97, layerStateInvalid: true },
    disposedNotices,
  );
  disposed.start();
  disposed.destroy();
  await flushDeferredNotice();
  assert.deepEqual(disposedNotices, []);
});

test('share-follow notices ignore superseded tracking results', async (t) => {
  installBrowserGlobals(t);
  const cover = new EventTarget();
  globalThis.document = {
    getElementById: (id) => (id === 'loading-screen' ? cover : null),
  };
  const priorGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  t.after(() => {
    if (priorGetComputedStyle === undefined)
      delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = priorGetComputedStyle;
  });

  const notices = [];
  const owner = createOwner(null, notices);
  owner.start();
  owner._handleShareTrackingRestoreStatus({
    classification: 'expired',
    label: 'flight',
    targetId: 'first',
  });
  await flushDeferredNotice();
  assert.deepEqual(notices, []);

  owner._handleShareTrackingRestoreStatus({
    classification: 'source-unavailable',
    label: 'flight',
    targetId: 'second',
  });
  await flushDeferredNotice();
  assert.deepEqual(notices, []);

  cover.dispatchEvent(new Event('transitionend'));
  assert.deepEqual(notices, [
    'Shared flight could not be restored — feed unavailable',
  ]);
  owner.destroy();
});
