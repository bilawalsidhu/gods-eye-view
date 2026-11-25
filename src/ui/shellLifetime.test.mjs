import assert from 'node:assert/strict';
import test from 'node:test';
import { LocationNavigation } from './locationNavigation.js';
import { LayerBindings } from './layerBindings.js';
import { bindRenderer } from '../render/rendererOf.js';
import { worldClock } from '../time/worldClock.js';

function replaceWindow(t, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
}

function location(t, { homeView = null } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  replaceWindow(t, { setTimeout });
  const calls = [];
  let hooks;
  const owner = new LocationNavigation({
    homeView,
    viewer: { camera: {
      cancelFlight() {}, lookAtTransform() {},
      positionCartographic: { latitude: 0, longitude: 0, height: 20000000 },
    } },
    services: {
      OrbitController: class { stop() { calls.push('orbit-stop'); } },
      GLOBE_VIEW: { heightM: 20000000 },
      flyToGlobeView(_viewer, callbacks) {
        hooks = callbacks;
        calls.push(callbacks.view ? `fly ${callbacks.view.lat},${callbacks.view.lon}` : 'fly here');
        return {};
      },
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

test('the logo goes live and flies to the home view, replacing a globe reset under way', async (t) => {
  const { owner, calls, readHooks } = location(t, {
    homeView: { lon: -82.5, lat: 35, height: 23000000 },
  });
  worldClock.seek(Date.now() - 3 * 3600 * 1000);
  assert.equal(worldClock.isLive(), false);
  const reset = owner.resetToGlobeView();
  const home = owner.returnToStart();
  assert.notEqual(home, reset);
  assert.equal((await reset).cancelled, true);
  assert.equal(worldClock.isLive(), true);
  assert.deepEqual(calls.filter((c) => c.startsWith('fly')), ['fly here', 'fly 35,-82.5']);
  readHooks().onComplete();
  assert.equal((await home).cancelled, false);
  assert.equal((await home).heightKm, 23000);
  owner.destroy();
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
  const controls = {
    hud: { attachDataManager() {} },
    _contextControls: { connect() {} },
    _cctvControls: { connect() {} }, _radioControls: { connect() {} },
    _streetLevelControls: { connects: 0, connect() { this.connects += 1; } },
  };
  const owner = new LayerBindings({
    viewer: {}, services: {}, readControls: () => controls,
    feedback: {}, shareRestoration: { connect() {} },
    operations: {
      _updateTrafficSyncChip() {}, _updateGlobalLoadingFeedback() {},
      _syncContextModeButtons() {},
    },
  });
  function manager(id, directions = true) {
    return {
      layers: new Map(directions ? [['directions', { module: {
        attachShellServices(value) { events.push([id, value ? 'attach' : 'detach']); },
      } }]] : []),
      subscribe() { events.push([id, 'subscribe']); return () => events.push([id, 'unsubscribe']); },
    };
  }
  return { owner, manager, events, controls };
}

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

test('attaching the manager reconnects Street Level, so its switch-on requests reach the panel', (t) => {
  const { owner, manager, controls } = bindings(t);
  owner.attachDataManager(manager('first'));
  assert.equal(controls._streetLevelControls.connects, 1);
  owner.stop(); owner.disconnect();
});

test('camera-entry listeners are removed before any asynchronous layer cleanup', (t) => {
  const { owner } = bindings(t);
  let changes = 0;
  let trackedCallback;
  // What the camera follows changes through its port's followChanged.
  owner.viewer = {};
  bindRenderer(owner.viewer, { camera: {
    followed: null,
    on(event, callback) {
      if (event !== 'followChanged') return () => {};
      trackedCallback = callback;
      return () => { changes += 1; };
    },
  } });
  owner._stampNavigation = () => { changes += 100; };
  owner.observeCamera();
  owner.stop();
  trackedCallback({});
  owner.stop();
  assert.equal(changes, 1);
});


test('weather shell supplies live imagery hosts to wind and observations and releases them', (t) => {
  const { owner } = bindings(t);
  let host = { collection: {}, kind: 'tileset' };
  owner.services.imageryHost = () => host;
  const attached = new Map();
  const ids = ['wind', 'weather-radar', 'weather-satellite', 'weather-lightning'];
  owner.attachDataManager({
    layers: new Map(ids.map(id => [id, { module: {
      attachShellServices(services) { attached.set(id, services); },
    } }])),
    subscribe: () => () => {},
  });
  for (const id of ids) assert.equal(attached.get(id).imageryHost(), host);
  host = { collection: null, kind: 'none' };
  for (const id of ids) assert.equal(attached.get(id).imageryHost(), host);
  owner.disconnect();
  for (const id of ids) assert.equal(attached.get(id), null);
});
