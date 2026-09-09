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
  watchBrowserPosition,
} from './browserGeolocation.js';

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
