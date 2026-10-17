import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEOLOCATION_DENIED,
  GEOLOCATION_TIMEOUT,
  GEOLOCATION_UNAVAILABLE,
  classifyGeolocationError,
  createPressGesture,
  geolocationErrorMessage,
  getCurrentBrowserPosition,
  isGeolocationAvailable,
  normalizeGeolocationPosition,
  isSecureGeolocationContext,
  watchBrowserPosition,
} from './browserGeolocation.js';

test('isSecureGeolocationContext rejects insecure, allows secure/undefined', () => {
  assert.equal(isSecureGeolocationContext({ isSecureContext: false }), false);
  assert.equal(isSecureGeolocationContext({ isSecureContext: true }), true);
  assert.equal(isSecureGeolocationContext({}), true);
  assert.equal(isSecureGeolocationContext(null), true);
});

test('isGeolocationAvailable requires getCurrentPosition', () => {
  assert.equal(isGeolocationAvailable(null), false);
  assert.equal(isGeolocationAvailable({}), false);
  assert.equal(isGeolocationAvailable({ getCurrentPosition() {} }), true);
});

test('classifyGeolocationError maps standard codes', () => {
  assert.equal(classifyGeolocationError({ code: 1 }), GEOLOCATION_DENIED);
  assert.equal(classifyGeolocationError({ code: 3 }), GEOLOCATION_TIMEOUT);
  assert.equal(classifyGeolocationError({ message: 'User denied Geolocation' }), GEOLOCATION_DENIED);
});

test('normalizeGeolocationPosition extracts lat/lon', () => {
  const fix = normalizeGeolocationPosition({
    timestamp: 1000,
    coords: {
      latitude: 30.2672,
      longitude: -97.7431,
      accuracy: 12,
      heading: null,
      speed: null,
    },
  });
  assert.equal(fix.lat, 30.2672);
  assert.equal(fix.lon, -97.7431);
  assert.equal(fix.accuracy, 12);
});

test('getCurrentBrowserPosition resolves a fix', async () => {
  const geo = {
    getCurrentPosition(success) {
      success({
        timestamp: 42,
        coords: { latitude: 1, longitude: 2, accuracy: 5, heading: NaN, speed: NaN },
      });
    },
  };
  const fix = await getCurrentBrowserPosition({ geo });
  assert.deepEqual(fix, {
    lat: 1,
    lon: 2,
    accuracy: 5,
    heading: null,
    speed: null,
    timestamp: 42,
  });
});

test('getCurrentBrowserPosition rejects when unavailable', async () => {
  await assert.rejects(
    () => getCurrentBrowserPosition({ geo: null }),
    (err) => {
      assert.equal(err.code, GEOLOCATION_UNAVAILABLE);
      assert.equal(err.message, geolocationErrorMessage(GEOLOCATION_UNAVAILABLE));
      return true;
    },
  );
});

test('getCurrentBrowserPosition rejects permission denied', async () => {
  const geo = {
    getCurrentPosition(_success, error) {
      error({ code: 1, message: 'denied' });
    },
  };
  await assert.rejects(
    () => getCurrentBrowserPosition({ geo }),
    (err) => err.code === GEOLOCATION_DENIED,
  );
});

test('watchBrowserPosition streams updates and stop clears watch', () => {
  const updates = [];
  let cleared = null;
  const geo = {
    getCurrentPosition() {},
    watchPosition(success) {
      success({
        timestamp: 1,
        coords: { latitude: 10, longitude: 20, accuracy: 3, heading: 90, speed: 1 },
      });
      return 77;
    },
    clearWatch(id) { cleared = id; },
  };
  const handle = watchBrowserPosition({
    geo,
    onUpdate: (fix) => updates.push(fix),
  });
  assert.equal(handle.watchId, 77);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].lat, 10);
  handle.stop();
  assert.equal(cleared, 77);
  handle.stop(); // idempotent
  assert.equal(cleared, 77);
});

test('createPressGesture fires click on short press and hold on long press', async () => {
  const clicks = [];
  const holds = [];
  const listeners = new Map();
  const el = {
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const gesture = createPressGesture({
    holdMs: 40,
    onClick: () => clicks.push('click'),
    onHold: () => holds.push('hold'),
  });
  const detach = gesture.attach(el);

  listeners.get('pointerdown')({ button: 0, pointerId: 1 });
  listeners.get('pointerup')({ pointerId: 1 });
  assert.deepEqual(clicks, ['click']);
  assert.deepEqual(holds, []);

  listeners.get('pointerdown')({ button: 0, pointerId: 2 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(holds, ['hold']);
  listeners.get('pointerup')({ pointerId: 2 });
  assert.deepEqual(clicks, ['click']); // no second click after hold

  detach();
});

test('createPressGesture forwards native click (keyboard/programmatic) without double-firing', async () => {
  const clicks = [];
  const listeners = new Map();
  const el = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const detach = createPressGesture({
    onClick: () => clicks.push('click'),
    onHold: () => {},
  }).attach(el);

  // Keyboard Enter/Space + element.click() report detail === 0.
  listeners.get('click')({ detail: 0 });
  assert.deepEqual(clicks, ['click']);
  listeners.get('click')({ detail: 0 });
  assert.deepEqual(clicks, ['click', 'click']);

  detach();
});

test('createPressGesture pointer click (detail >= 1) does not double-fire via native click', async () => {
  const clicks = [];
  const listeners = new Map();
  const el = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const detach = createPressGesture({
    onClick: () => clicks.push('click'),
    onHold: () => {},
  }).attach(el);

  // A real pointer click: pointerdown -> pointerup (fires) -> native click detail 1.
  listeners.get('pointerdown')({ button: 0, pointerId: 7 });
  listeners.get('pointerup')({ pointerId: 7 });
  listeners.get('click')({ detail: 1 });
  assert.deepEqual(clicks, ['click']);

  detach();
});

test('createPressGesture keydown Shift+Enter/Space invokes hold', async () => {
  const holds = [];
  const listeners = new Map();
  const el = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const detach = createPressGesture({
    onClick: () => {},
    onHold: () => holds.push('hold'),
  }).attach(el);

  listeners.get('keydown')({ key: 'Enter', shiftKey: true, preventDefault() {} });
  assert.deepEqual(holds, ['hold']);
  listeners.get('keydown')({ key: ' ', shiftKey: true, preventDefault() {} });
  assert.deepEqual(holds, ['hold', 'hold']);
  listeners.get('keydown')({ key: 'Enter', shiftKey: false });
  assert.deepEqual(holds, ['hold', 'hold']); // plain Enter is not a hold

  detach();
});

test('createPressGesture removes all listeners, including contextmenu, on detach', () => {
  const removed = new Map();
  const el = {
    addEventListener(type, fn) {},
    removeEventListener(type, fn) {
      removed.set(type, fn);
    },
  };
  const detach = createPressGesture({
    onClick: () => {},
    onHold: () => {},
  }).attach(el);
  detach();
  for (const type of [
    'pointerdown',
    'pointerup',
    'pointerleave',
    'pointercancel',
    'contextmenu',
    'click',
    'keydown',
  ]) {
    assert.ok(removed.has(type), `detach must remove ${type}`);
  }
});
