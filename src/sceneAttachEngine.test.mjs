// The session objects an engine switch keeps follow the next globe's camera
// (attachEngine / setScene) instead of being rebuilt, and hold no listener on
// the globe they left.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from './globe/testing/fakeEngine.js';
import { ShareLinkManager } from './sharelink.js';
import { OrbitController } from './orbit.js';
import { NavigationController } from './ui/navigationController.js';

const listeners = (event) => event.numberOfListeners;

test('the share link follows the attached camera and writes nothing between engines', (t) => {
  const prior = { window: globalThis.window, history: globalThis.history };
  const writes = [];
  globalThis.window = Object.assign(new EventTarget(), {
    location: new URL('http://localhost/'),
  });
  globalThis.history = { replaceState: (...args) => writes.push(args) };
  t.after(() => Object.assign(globalThis, prior));
  const first = createFakeEngine();
  const second = createFakeEngine();
  const manager = new ShareLinkManager(first);
  assert.equal(listeners(first.camera.changed), 1);
  manager.attachEngine(null);
  assert.equal(listeners(first.camera.changed), 0);
  assert.equal(manager.engine, null);
  manager._updateHash();
  assert.equal(writes.length, 0, 'no camera, no address write');
  assert.equal(manager.buildLink(), null);
  manager.attachEngine(second);
  assert.equal(listeners(second.camera.changed), 1);
  assert.equal(manager.engine, second);
  manager.destroy();
  assert.equal(listeners(second.camera.changed), 0);
});

test('an orbit stops when its globe leaves and orbits the next one', () => {
  const first = createFakeEngine();
  const second = createFakeEngine();
  const orbit = new OrbitController(first);
  orbit.start({ x: 6378137, y: 0, z: 0 });
  assert.equal(orbit.active, true);
  assert.equal(listeners(first.frames.preRender), 1);
  orbit.attachEngine(second);
  assert.equal(orbit.active, false);
  assert.equal(listeners(first.frames.preRender), 0);
  orbit.start({ x: 6378137, y: 0, z: 0 });
  assert.equal(listeners(second.frames.preRender), 1);
  orbit.stop();
});

test('navigation authority retires deferred flights when the globe changes', () => {
  const first = createFakeEngine();
  const second = createFakeEngine();
  const none = {
    cancelPendingTrackingRestore() {},
    getTrackedInfo: () => null,
  };
  const navigation = new NavigationController({
    engine: first,
    tracking: {
      flightsLayer: none,
      militaryFlightsLayer: none,
      satellitesLayer: none,
    },
    interruptCameraMotion() {},
    isCockpitActive: () => false,
    clearLocation() {},
    cancelShareSelection: () => false,
    getDataManager: () => null,
    stopOrbit() {},
    showToast() {},
  });
  const generation = navigation._beginDeferredNavigation('shared view');
  assert.equal(Number.isInteger(generation), true);
  navigation.setScene({ engine: null });
  assert.equal(navigation.engine, null);
  assert.equal(
    navigation._reassertNavigationHandoff(generation),
    false,
    'a flight deferred on the outgoing globe cannot land on the next one',
  );
  navigation.setScene({ engine: second });
  assert.equal(navigation.engine, second);
  const next = navigation._beginDeferredNavigation('location');
  assert.equal(navigation._reassertNavigationHandoff(next), true);
});

test('between engines the globe reset neither stamps navigation nor reads a camera', async () => {
  const { LocationNavigation } = await import('./ui/locationNavigation.js');
  const location = Object.create(LocationNavigation.prototype);
  let stamped = 0;
  Object.assign(location, {
    services: { interruptCameraMotion() {} },
    engine: null,
    _disposed: false,
    _stampNavigation: () => stamped++,
  });
  const result = await location.resetToGlobeView();
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(stamped, 0);
});
