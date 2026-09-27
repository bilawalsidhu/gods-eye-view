import assert from 'node:assert/strict';
import test from 'node:test';
import { NavigationController } from './navigationController.js';
import { ShareRestoration } from './shareRestoration.js';

function navigation() {
  const tracking = Object.fromEntries(
    [
      'flightsLayer',
      'militaryFlightsLayer',
      'satellitesLayer',
      'aisLiveVesselsLayer',
      'militaryAwarenessLayer',
      'rocketLaunchesLayer',
    ].map((name) => [name, {}]),
  );
  return new NavigationController({
    viewer: { camera: { cancelFlight() {}, lookAtTransform() {} } },
    tracking,
    searchInput: null,
    interruptCameraMotion() {},
    isCockpitActive: () => false,
    clearLocation() {},
    cancelShareSelection: () => false,
    getDataManager: () => null,
    stopOrbit() {},
    showToast() {},
  });
}

test('navigation generations belong to their owner and teardown closes both entry paths', () => {
  const first = navigation();
  const second = navigation();
  const a = first._beginDeferredNavigation();
  const b = second._beginDeferredNavigation();
  first._stampNavigation();
  assert.equal(first._reassertNavigationHandoff(a), false);
  assert.equal(second._reassertNavigationHandoff(b), true);
  let flights = 0;
  second.stop();
  assert.equal(second._beginDeferredNavigation(), false);
  assert.equal(
    second._runExplicitNavigation('location', () => {
      flights += 1;
    }),
    false,
  );
  assert.equal(flights, 0);
  const generation = second._navigationGeneration;
  second.destroy();
  assert.equal(second._navigationGeneration, generation + 1);
});

test('share teardown settles its promise, removes gestures and rejects a retained timer callback', async (t) => {
  const prior = {
    window: globalThis.window,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const timers = new Map();
  let timerId = 0;
  globalThis.window = new EventTarget();
  globalThis.setTimeout = (fn) => {
    timers.set(++timerId, fn);
    return timerId;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  t.after(() => Object.assign(globalThis, prior));
  const canvas = new EventTarget();
  let stamps = 0;
  let applies = 0;
  const owner = new ShareRestoration({
    viewer: { canvas },
    navigation: {
      _beginDeferredNavigation: () => 1,
      _reassertNavigationHandoff: () => true,
      _stampNavigation: () => {
        stamps += 1;
      },
    },
    syncShareState() {},
    syncModels3d() {},
    showStatus() {},
    feedback: {},
    updateFeedback() {},
  });
  owner.attachLinks({
    parseInitialHash: () => ({ latitude: 30, longitude: -97 }),
    applyState: async () => {
      applies += 1;
      return { camera: 'applied' };
    },
    completeInitialRestore() {},
  });
  owner.start();
  const retained = [...timers.values()][0];
  canvas.dispatchEvent(new Event('wheel'));
  assert.equal(stamps, 1);
  owner.destroy();
  assert.equal((await owner.initialRestorePromise).status, 'destroyed');
  assert.equal(timers.size, 0);
  canvas.dispatchEvent(new Event('wheel'));
  retained();
  await Promise.resolve();
  assert.equal(stamps, 1);
  assert.equal(applies, 0);
});

test('a rejected shared layer payload says the selection could not be restored', async (t) => {
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const timers = new Map();
  const frames = [];
  let timerId = 0;
  globalThis.window = new EventTarget();
  globalThis.document = { getElementById: () => null };
  globalThis.setTimeout = (fn) => {
    timers.set(++timerId, fn);
    return timerId;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.requestAnimationFrame = (fn) => {
    frames.push(fn);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => Object.assign(globalThis, prior));
  const notices = [];
  const owner = new ShareRestoration({
    viewer: { canvas: new EventTarget() },
    navigation: {
      _beginDeferredNavigation: () => 1,
      _reassertNavigationHandoff: () => true,
      _stampNavigation() {},
    },
    syncShareState() {},
    syncModels3d() {},
    showStatus(message) {
      notices.push(message);
    },
    feedback: {},
    updateFeedback() {},
  });
  owner.attachLinks({
    parseInitialHash: () => ({
      latitude: 30,
      longitude: -97,
      layerState: null,
      layerStateInvalid: true,
    }),
    applyState: async () => ({ camera: 'applied' }),
    completeInitialRestore() {},
  });
  owner.start();
  assert.deepEqual(notices, []);
  [...timers.values()][0]();
  await owner.initialRestorePromise;
  await Promise.resolve();
  for (const frame of frames) frame(0);
  assert.deepEqual(notices, ['Shared layer selection could not be restored']);
});

test('a pending shared-subject acquisition does not permanently hide the rejected-layer notice', () => {
  const scheduled = [];
  let feedbackUpdates = 0;
  const owner = Object.create(ShareRestoration.prototype);
  Object.assign(owner, {
    _disposed: false,
    _shareTrackingNoticeGeneration: 7,
    _shareTrackingAcquiringKey: 'flights:abc',
    _pendingInvalidShareLayerNotice:
      'Shared layer selection could not be restored',
    feedback: { _globalStatusNotice: { state: 'acquiring' } },
    updateFeedback() {
      feedbackUpdates += 1;
    },
    _scheduleDeferredShareNotice(message, generation) {
      scheduled.push({ message, generation });
    },
  });

  owner._handleShareTrackingRestoreStatus({
    layerId: 'flights',
    targetId: 'abc',
    classification: 'followed',
  });

  assert.equal(owner._shareTrackingAcquiringKey, null);
  assert.equal(owner.feedback._globalStatusNotice, null);
  assert.equal(feedbackUpdates, 1);
  assert.deepEqual(scheduled, [
    {
      message: 'Shared layer selection could not be restored',
      generation: 9,
    },
  ]);
});

test('a concrete shared-subject failure takes precedence over the rejected-layer notice', () => {
  const scheduled = [];
  const owner = Object.create(ShareRestoration.prototype);
  Object.assign(owner, {
    _disposed: false,
    _shareTrackingNoticeGeneration: 2,
    _shareTrackingAcquiringKey: 'flights:abc',
    _pendingInvalidShareLayerNotice:
      'Shared layer selection could not be restored',
    feedback: { _globalStatusNotice: { state: 'acquiring' } },
    updateFeedback() {},
    _scheduleDeferredShareNotice(message, generation) {
      scheduled.push({ message, generation });
    },
  });

  owner._handleShareTrackingRestoreStatus({
    layerId: 'flights',
    targetId: 'abc',
    classification: 'source-unavailable',
    label: 'flight',
  });

  assert.equal(owner._pendingInvalidShareLayerNotice, null);
  assert.deepEqual(scheduled, [
    {
      message: 'Shared flight could not be restored — feed unavailable',
      generation: 3,
    },
  ]);
});

test('valid shared layer payloads stay silent', async (t) => {
  const prior = {
    window: globalThis.window,
    document: globalThis.document,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const timers = new Map();
  const frames = [];
  let timerId = 0;
  globalThis.window = new EventTarget();
  globalThis.document = { getElementById: () => null };
  globalThis.setTimeout = (fn) => {
    timers.set(++timerId, fn);
    return timerId;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.requestAnimationFrame = (fn) => {
    frames.push(fn);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => Object.assign(globalThis, prior));
  const notices = [];
  for (const layerState of [
    { layerState: ['flights'], layerStateInvalid: false },
    { layerState: [], layerStateInvalid: false },
    { layerState: ['flights'] },
  ]) {
    timers.clear();
    frames.length = 0;
    const owner = new ShareRestoration({
      viewer: { canvas: new EventTarget() },
      navigation: {
        _beginDeferredNavigation: () => 1,
        _reassertNavigationHandoff: () => true,
        _stampNavigation() {},
      },
      syncShareState() {},
      syncModels3d() {},
      showStatus(message) {
        notices.push(message);
      },
      feedback: {},
      updateFeedback() {},
    });
    owner.attachLinks({
      parseInitialHash: () => ({ latitude: 30, longitude: -97, ...layerState }),
      applyState: async () => ({ camera: 'applied' }),
      completeInitialRestore() {},
    });
    owner.start();
    [...timers.values()][0]();
    await owner.initialRestorePromise;
    await Promise.resolve();
    for (const frame of frames) frame(0);
    owner.destroy();
  }
  assert.deepEqual(notices, []);
});

test('visual teardown restores owned fog and aircraft sensor state once', async (t) => {
  const { VisualSettings } = await import('./visualSettings.js');
  const priorDocument = globalThis.document;
  globalThis.document = {
    documentElement: { dataset: {} },
    getElementById: () => null,
  };
  t.after(() => {
    globalThis.document = priorDocument;
  });
  const calls = [];
  const viewer = { scene: { fog: { enabled: false } } };
  const owner = new VisualSettings({
    viewer,
    elements: {},
    operations: {},
    services: {
      governorRequestRender() {},
      holdContinuousRender() {},
      releaseContinuousRender() {},
    },
    readDataManager: () => ({ setLayerParams: (...args) => calls.push(args) }),
  });
  owner._irBoostActive = true;
  owner._irFogWasEnabled = true;
  owner.releaseIrBoost();
  owner.releaseIrBoost();
  assert.equal(viewer.scene.fog.enabled, true);
  assert.deepEqual(calls, [
    ['flights', { irBoost: false }],
    ['military', { irBoost: false }],
  ]);
  assert.equal(owner._irBoostActive, false);
  owner.destroy();
});
