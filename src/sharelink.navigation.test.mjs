import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShareLinkManager } from './sharelink.js';
import { ShareRestoration } from './ui/shareRestoration.js';
import { DataLayerManager } from './data/manager.js';
import {
  LAYER_STATE_REGISTRY,
  REGISTERED_LAYER_IDS,
  createDefaultLayerState,
  decodeLayerStateParams,
} from './data/layerState.js';
import { LayerStateCoordinator } from './data/layerStateCoordinator.js';

const SHARE_A = 'v=2&lat=10.0000&lon=20.0000&alt=800&style=nvg&l=e';
const SHARE_B = 'v=2&lat=48.8584&lon=2.2945&alt=500&style=normal&l=f';

/**
 * A window whose address behaves like a tab's: `navigate` is a hash-only
 * navigation (new history entry plus hashchange), `back`/`forward` traverse
 * entries (popstate plus hashchange), and `history.replaceState` rewrites the
 * current entry without firing anything.
 */
function installTab(t, initialHash = '') {
  const prior = {
    window: globalThis.window,
    history: globalThis.history,
  };
  const target = new EventTarget();
  const location = new URL(
    `http://localhost/${initialHash ? `#${initialHash}` : ''}`,
  );
  const entries = [location.hash];
  let index = 0;
  const listeners = { hashchange: 0, popstate: 0 };
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type, handler, options) => {
    if (type in listeners) listeners[type] += 1;
    add(type, handler, options);
  };
  target.removeEventListener = (type, handler, options) => {
    if (type in listeners) listeners[type] -= 1;
    remove(type, handler, options);
  };
  target.location = location;
  globalThis.window = target;
  globalThis.history = {
    replaceState(_state, _title, next) {
      location.hash = new URL(next, location.href).hash;
      entries[index] = location.hash;
    },
  };
  t.after(() => Object.assign(globalThis, prior));
  const go = (nextIndex) => {
    index = nextIndex;
    location.hash = entries[index];
    target.dispatchEvent(new Event('popstate'));
    target.dispatchEvent(new Event('hashchange'));
  };
  return {
    listeners,
    navigate(hash) {
      entries.splice(index + 1);
      entries.push(`#${hash}`);
      index = entries.length - 1;
      location.hash = hash;
      target.dispatchEvent(new Event('hashchange'));
    },
    back: () => go(index - 1),
    forward: () => go(index + 1),
  };
}

/** Queue timers instead of running them, so delayed work runs only on demand. */
function installManualTimers(t) {
  const prior = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  const timers = new Map();
  let timerId = 0;
  globalThis.setTimeout = (fn) => {
    timers.set(++timerId, fn);
    return timerId;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  t.after(() => Object.assign(globalThis, prior));
  return timers;
}

function fakeViewer() {
  return {
    camera: {
      changed: { addEventListener: () => () => {} },
      positionCartographic: { latitude: 0, longitude: 0, height: 1000 },
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
}

test('a hash navigation to a different share restores it and holds URL writes', (t) => {
  const tab = installTab(t, SHARE_A);
  const manager = new ShareLinkManager(fakeViewer());
  const initial = manager.parseInitialHash();
  manager.completeInitialRestore(initial.restoreToken);
  const navigated = [];
  manager.watchNavigation((state) => navigated.push(state));

  tab.navigate(SHARE_B);
  assert.equal(navigated.length, 1);
  assert.equal(navigated[0].lat, 48.8584);
  assert.equal(navigated[0].style, 'normal');
  assert.deepEqual(navigated[0].layerState.enabledLayerIds, ['flights']);
  assert.equal(manager._initialRestorePending, true);
  // Nothing from the previous view may overwrite the incoming link.
  manager._updateHash();
  assert.equal(window.location.hash, `#${SHARE_B}`);
  manager.completeInitialRestore(navigated[0].restoreToken);
  assert.equal(manager._initialRestorePending, false);
  manager.destroy();
});

test("the app's own hash writes never trigger a restore", (t) => {
  installTab(t, SHARE_A);
  const manager = new ShareLinkManager(fakeViewer());
  manager.completeInitialRestore(manager.parseInitialHash().restoreToken);
  let restores = 0;
  manager.watchNavigation(() => {
    restores += 1;
  });
  manager._updateHash();
  assert.notEqual(window.location.hash, `#${SHARE_A}`);
  // replaceState fires nothing, but a stray event for our own hash is ignored.
  window.dispatchEvent(new Event('hashchange'));
  window.dispatchEvent(new Event('popstate'));
  assert.equal(restores, 0);
  assert.equal(manager._initialRestorePending, false);
  manager.destroy();
});

test('a non-share hash is ignored and Back/Forward restores each entry once', (t) => {
  const tab = installTab(t, SHARE_A);
  const manager = new ShareLinkManager(fakeViewer());
  manager.completeInitialRestore(manager.parseInitialHash().restoreToken);
  // The app rewrites entry 0 with its own state; Back must return to that.
  manager._updateHash();
  const ownHash = window.location.hash.slice(1);
  const navigated = [];
  manager.watchNavigation((state) => navigated.push(state));

  tab.navigate('not-a-share');
  assert.equal(navigated.length, 0);
  assert.equal(manager._initialRestorePending, false);

  tab.navigate(SHARE_B);
  assert.equal(navigated.length, 1);
  manager.completeInitialRestore(navigated[0].restoreToken);

  tab.back(); // not-a-share
  tab.back(); // the app's own rewritten first entry
  assert.equal(navigated.length, 2, 'popstate and hashchange restore once');
  assert.equal(window.location.hash.slice(1), ownHash);
  assert.equal(navigated[1].lat, 0);
  manager.completeInitialRestore(navigated[1].restoreToken);

  tab.forward();
  tab.forward();
  assert.equal(navigated.length, 3);
  assert.equal(navigated[2].lat, 48.8584);
  manager.destroy();
});

test('a newer navigation supersedes an older restore and its pending write', (t) => {
  const tab = installTab(t, SHARE_A);
  const timers = installManualTimers(t);

  const manager = new ShareLinkManager(fakeViewer());
  manager.completeInitialRestore(manager.parseInitialHash().restoreToken);
  assert.equal(timers.size, 1, 'releasing suppression schedules a write');
  const navigated = [];
  manager.watchNavigation((state) => navigated.push(state));

  tab.navigate(SHARE_B);
  assert.equal(
    timers.size,
    0,
    'the pending write of the old view is cancelled',
  );
  tab.navigate(SHARE_A);
  const [older, newer] = navigated;
  assert.ok(newer.restoreToken > older.restoreToken);
  manager.completeInitialRestore(older.restoreToken);
  assert.equal(
    manager._initialRestorePending,
    true,
    'a superseded restore cannot release writes',
  );
  manager.completeInitialRestore(newer.restoreToken);
  assert.equal(manager._initialRestorePending, false);
  manager.destroy();
});

test('destroy removes the navigation listeners', (t) => {
  const tab = installTab(t, SHARE_A);
  const manager = new ShareLinkManager(fakeViewer());
  manager.parseInitialHash();
  let restores = 0;
  manager.watchNavigation(() => {
    restores += 1;
  });
  assert.deepEqual(tab.listeners, { hashchange: 1, popstate: 1 });
  manager.watchNavigation(() => {
    restores += 1;
  });
  assert.deepEqual(
    tab.listeners,
    { hashchange: 1, popstate: 1 },
    'rewatching replaces',
  );
  manager.destroy();
  assert.deepEqual(tab.listeners, { hashchange: 0, popstate: 0 });
  tab.navigate(SHARE_B);
  assert.equal(restores, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A ShareRestoration over a real ShareLinkManager with a stub restore sink. */
function restorationHarness(t, initialHash, navigationOverrides = {}) {
  const tab = installTab(t, initialHash);
  const timers = installManualTimers(t);

  const restores = [];
  let navigationGeneration = 0;
  const manager = new ShareLinkManager(fakeViewer(), {
    onRestore: (state) => {
      const gate = deferred();
      restores.push({ state, gate });
      return gate.promise;
    },
    isNavigationCurrent: () => false,
  });
  const layerCalls = [];
  const handoffs = [];
  const owner = new ShareRestoration({
    viewer: { canvas: new EventTarget() },
    navigation: {
      _beginDeferredNavigation: () => ++navigationGeneration,
      _reassertNavigationHandoff: (generation, options) => {
        handoffs.push({ generation, options });
        return true;
      },
      _stampNavigation() {},
      ...navigationOverrides,
    },
    syncShareState() {},
    syncModels3d() {},
    showStatus() {},
    feedback: {},
    updateFeedback() {},
  });
  owner.attachLinks(manager);
  owner._layerStateCoordinator = {
    applyShareLayerState(options) {
      layerCalls.push(options);
      return Promise.resolve([]);
    },
    getDurableState: () => null,
    cancelPendingShareTracking: () => false,
    destroy() {},
  };
  owner.start();
  t.after(() => owner.destroy());
  return { tab, timers, manager, owner, restores, layerCalls, handoffs };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a navigated share runs the start-up restore pipeline and supersedes the delayed one', async (t) => {
  const { tab, timers, manager, owner, restores, layerCalls } =
    restorationHarness(t, SHARE_A);
  assert.equal(timers.size, 1, 'start-up restore waits for its delayed flight');

  tab.navigate(SHARE_B);
  assert.equal(timers.size, 0, 'the delayed start-up restore never runs');
  assert.equal((await owner.initialRestorePromise).status, 'superseded');
  assert.equal(restores.length, 1);
  assert.equal(restores[0].state.style, 'normal');
  assert.equal(restores[0].state.mapStack, 'photoreal');
  assert.deepEqual(layerCalls[0].shareLayerState.enabledLayerIds, ['flights']);

  restores[0].gate.resolve();
  await flush();
  assert.equal(manager._initialRestorePending, false);
});

test('a navigated share releases the old Follow passively, never as a saved preference', (t) => {
  const { tab, handoffs } = restorationHarness(t, SHARE_A);
  tab.navigate(SHARE_B);
  assert.equal(handoffs.length, 1);
  assert.deepEqual(handoffs[0].options, { trackingOrigin: 'programmatic' });
});

test('a navigated share that fails to start never freezes the address bar', async (t) => {
  const settled = [];
  let calls = 0;
  const { tab, manager } = restorationHarness(t, SHARE_A, {
    // Start-up reserves the camera; the navigated share then fails to.
    _beginDeferredNavigation: () => {
      calls += 1;
      if (calls > 1) throw new Error('navigation unavailable');
      return calls;
    },
  });
  window.addEventListener('gev:share-navigation-restore-settled', (event) =>
    settled.push(event.detail),
  );
  tab.navigate(SHARE_B);
  assert.equal(manager._initialRestorePending, false);
  assert.equal(settled[0]?.status, 'failed');
});

test('a second navigation during a restore supersedes it end to end', async (t) => {
  const { tab, manager, restores, layerCalls } = restorationHarness(t, SHARE_A);
  tab.navigate(SHARE_B);
  tab.navigate(SHARE_A);
  assert.equal(restores.length, 2);
  assert.equal(layerCalls.length, 2);
  assert.deepEqual(layerCalls[1].shareLayerState.enabledLayerIds, [
    'earthquakes',
  ]);

  // The newer restore finishes first; the older one settling late must not
  // release or reopen anything.
  restores[1].gate.resolve();
  await flush();
  assert.equal(manager._initialRestorePending, false);
  manager._initialRestorePending = true; // observe any late release
  restores[0].gate.resolve();
  await flush();
  assert.equal(manager._initialRestorePending, true);
});

test('the layer coordinator replaces in-flight share layers with the navigated share', async () => {
  const enableGates = new Map();
  const manager = new DataLayerManager({});
  for (const id of REGISTERED_LAYER_IDS) {
    manager.register({
      id,
      name: id,
      icon: '',
      source: 'test',
      async init() {
        return true;
      },
      async enable() {
        const gate = enableGates.get(id);
        if (gate) await gate.promise;
        return true;
      },
      async update() {
        return true;
      },
      async disable() {
        return true;
      },
    });
  }
  manager.finalizeRegistrations(LAYER_STATE_REGISTRY);
  const quakeGate = deferred();
  enableGates.set('earthquakes', quakeGate);
  const writes = [];
  const storage = {
    getItem: () => null,
    setItem: (...args) => writes.push(args),
  };
  const sink = {
    provider: null,
    setLayerStateProvider(provider) {
      this.provider = provider;
    },
    onLayerStateChange() {},
  };
  const coordinator = new LayerStateCoordinator(manager, sink, { storage });
  const first = coordinator.start({
    shareLayerState: decodeLayerStateParams(new URLSearchParams(SHARE_A)),
    allowLocalState: false,
  });
  const second = coordinator.applyShareLayerState({
    shareLayerState: decodeLayerStateParams(new URLSearchParams(SHARE_B)),
  });
  quakeGate.resolve();
  await Promise.all([first, second]);
  const enabled = (id) => manager.getLayerLifecycleState(id)?.enabled === true;
  assert.equal(enabled('earthquakes'), false);
  assert.equal(enabled('flights'), true);
  assert.deepEqual(sink.provider().enabledLayerIds, ['flights']);
  assert.equal(coordinator.source, 'share');
  assert.deepEqual(
    writes,
    [],
    'a passive share restore never writes local preferences',
  );

  // A share without a layer payload restores the defaults, as a reload does.
  await coordinator.applyShareLayerState({ shareLayerState: null });
  assert.equal(coordinator.source, 'legacy-share');
  assert.deepEqual(
    sink.provider().enabledLayerIds,
    createDefaultLayerState().enabledLayerIds,
  );
  assert.equal(
    enabled('flights'),
    createDefaultLayerState().enabledLayerIds.includes('flights'),
  );
  coordinator.destroy();
});
