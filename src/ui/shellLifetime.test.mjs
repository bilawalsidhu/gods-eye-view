import assert from 'node:assert/strict';
import test from 'node:test';
import { LocationNavigation } from './locationNavigation.js';
import { LayerBindings } from './layerBindings.js';

function replaceWindow(t, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
}

function location(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  replaceWindow(t, { setTimeout });
  const calls = [];
  let hooks;
  const owner = new LocationNavigation({
    viewer: { camera: {
      cancelFlight() {}, lookAtTransform() {},
      positionCartographic: { latitude: 0, longitude: 0, height: 20000000 },
    } },
    services: {
      OrbitController: class { stop() { calls.push('orbit-stop'); } },
      GLOBE_VIEW: { heightM: 20000000 },
      flyToGlobeView(_viewer, callbacks) { hooks = callbacks; return {}; },
      interruptCameraMotion() {},
      militaryAwarenessLayer: {}, satellitesLayer: {}, rocketLaunchesLayer: {},
      trafficLayer: {
        beginWorldJump() { calls.push('begin'); },
        endWorldJump() { calls.push('end'); },
      },
      suspendDetection() { calls.push('suspend'); },
      resumeDetection() { calls.push('resume'); },
    },
    elements: {}, navigation: {}, readCockpit: () => null,
    operations: {
      _stampNavigation() {}, _updateTrafficSyncChip() {},
      _runExplicitNavigation(_noun, run) { return run(); },
    },
  });
  return { owner, calls, readHooks: () => hooks };
}

test('shell disposal settles a pending globe reset once and revokes its timeout', async (t) => {
  const { owner, calls, readHooks } = location(t);
  const pending = owner.resetToGlobeView();
  assert.equal(owner.resetToGlobeView(), pending);
  owner.destroy();
  assert.equal((await pending).cancelled, true);
  const after = [...calls];
  readHooks().onComplete();
  t.mock.timers.tick(10000);
  owner.destroy();
  assert.deepEqual(calls, after);
  assert.equal(calls.filter(c => c === 'resume').length, 1);
  assert.equal((await owner.resetToGlobeView()).cancelled, true);
});

test('world jump completion cannot revive navigation after shell disposal', (t) => {
  const { owner, calls } = location(t);
  let complete;
  owner._flyWithTransition(true, ({ onStart, onComplete }) => {
    onStart(); complete = onComplete;
  });
  owner.destroy();
  const after = [...calls];
  complete();
  t.mock.timers.tick(10000);
  assert.deepEqual(calls, after);
  assert.equal(calls.filter(c => c === 'resume').length, 1);
});

function bindings(t) {
  replaceWindow(t, new EventTarget());
  const events = [];
  const presence = [];
  const listeners = [];
  const controls = {
    hud: { attachDataManager() {} },
    _contextControls: { connect() {} },
    _cctvControls: { connect() {} }, _radioControls: { connect() {} },
  };
  const owner = new LayerBindings({
    viewer: {}, services: {}, readControls: () => controls,
    feedback: {}, shareRestoration: { connect() {} },
    operations: {
      _updateTrafficSyncChip() {}, _updateGlobalLoadingFeedback() {},
      _syncContextModeButtons() {},
      _syncWeatherPanelPresence(change) { presence.push(change); },
    },
  });
  function manager(id, directions = true) {
    return {
      layers: new Map(directions ? [['directions', { module: {
        attachShellServices(value) { events.push([id, value ? 'attach' : 'detach']); },
      } }]] : []),
      subscribe(handler) {
        events.push([id, 'subscribe']);
        listeners.push(handler);
        return () => events.push([id, 'unsubscribe']);
      },
    };
  }
  return { owner, manager, events, presence, listeners };
}

test('the Weather panel reacts to who switched the layer on', (t) => {
  // Switching the layer on from the left rail is a request to use it, so its
  // controls should be open. A share link or a scene carries the panel state
  // its author chose, and restoring one must not override it — so the change's
  // origin has to reach the panel, not just the fact that it changed.
  const env = bindings(t);
  env.owner.attachDataManager(env.manager('a'));
  assert.equal(env.listeners.length, 1, 'the owner subscribes');
  env.presence.length = 0;

  const notify = (change) => env.listeners[0](change);
  notify({ type: 'visibility', layerId: 'weather', enabled: true, origin: 'user' });
  notify({ type: 'visibility', layerId: 'weather', enabled: true, origin: 'share' });
  notify({ type: 'visibility', layerId: 'cctv', enabled: true, origin: 'user' });
  notify({ type: 'refresh', layerId: 'weather' });

  assert.deepEqual(
    env.presence.map((change) => change?.origin),
    ['user', 'share'],
    'only weather visibility reaches the panel, and it carries its origin',
  );
});

test('manager replacement releases Directions even when the new manager has no route layer', (t) => {
  const { owner, manager, events } = bindings(t);
  owner.attachDataManager(manager('old'));
  owner.attachDataManager(manager('new', false));
  assert.deepEqual(events, [
    ['old', 'subscribe'], ['old', 'attach'], ['old', 'unsubscribe'],
    ['new', 'subscribe'], ['old', 'detach'],
  ]);
  owner.stop(); owner.disconnect();
  assert.deepEqual(events.at(-1), ['new', 'unsubscribe']);
  const count = events.length;
  owner.attachDataManager(manager('late'));
  owner.stop(); owner.disconnect();
  assert.equal(events.length, count);
});

test('camera-entry listeners are removed before any asynchronous layer cleanup', (t) => {
  const { owner } = bindings(t);
  let changes = 0;
  let trackedCallback;
  owner.viewer = { trackedEntityChanged: {
    addEventListener(callback) {
      trackedCallback = callback;
      return () => { changes += 1; };
    },
  } };
  owner._stampNavigation = () => { changes += 100; };
  owner.observeCamera();
  owner.stop();
  trackedCallback({});
  owner.stop();
  assert.equal(changes, 1);
});
