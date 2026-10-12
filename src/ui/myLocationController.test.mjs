import assert from 'node:assert/strict';
import test from 'node:test';
import { MyLocationController } from './myLocationController.js';
import {
  readMyLocationState,
  resetMyLocationState,
} from '../myLocationState.js';

function createHarness() {
  resetMyLocationState();
  let nextWatchId = 1;
  const geo = {
    calls: [],
    watchPosition(success, error, options) {
      const id = nextWatchId++;
      this.calls.push({ id, success, error, options });
      return id;
    },
    clearWatchCalls: [],
    clearWatch(id) {
      this.clearWatchCalls.push(id);
    },
  };
  const listeners = new Map();
  const viewer = {
    camera: {
      heading: 0,
      flights: [],
      cancelFlight() {
        this.cancelled = (this.cancelled || 0) + 1;
      },
      flyToBoundingSphere(target, options) {
        this.flights.push({ target, options });
      },
    },
    dataSources: {
      added: [],
      removed: [],
      add(dataSource) {
        this.added.push(dataSource);
      },
      remove(dataSource) {
        this.removed.push(dataSource);
      },
    },
  };
  const renders = [];
  const eventTarget = {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      listeners.get(name)?.delete(callback);
    },
    dispatch(name) {
      for (const callback of listeners.get(name) || []) callback();
    },
  };
  const controller = new MyLocationController({
    viewer,
    geolocation: geo,
    eventTarget,
    render: { governorRequestRender: (reason) => renders.push(reason) },
  });
  return { controller, geo, viewer, eventTarget, renders };
}

test('my location stays idle until explicitly enabled, then recenters only on the first fix', () => {
  const h = createHarness();
  assert.equal(h.geo.calls.length, 0);
  assert.equal(readMyLocationState().status, 'off');

  assert.equal(h.controller.enable(), true);
  assert.equal(h.geo.calls.length, 1);
  assert.equal(readMyLocationState().status, 'requesting');

  const firstFix = {
    coords: { latitude: 30.2672, longitude: -97.7431, accuracy: 35 },
    timestamp: 101,
  };
  h.geo.calls[0].success(firstFix);
  assert.equal(readMyLocationState().status, 'ready');
  assert.equal(readMyLocationState().position.latitude, 30.2672);
  assert.equal(h.viewer.camera.flights.length, 1);
  assert.equal(h.controller.dataSource.entities.values.length, 1);

  h.geo.calls[0].success({
    coords: { latitude: 30.26720001, longitude: -97.74310001, accuracy: 34 },
    timestamp: 102,
  });
  assert.equal(
    h.viewer.camera.flights.length,
    1,
    'subsequent GPS updates must not force the camera to follow',
  );
});

test('my location disable and unload cleanup clear the watcher and browser-side state', () => {
  const h = createHarness();
  h.controller.enable();
  h.geo.calls[0].success({
    coords: { latitude: 30.2672, longitude: -97.7431, accuracy: 30 },
    timestamp: 101,
  });
  assert.equal(h.controller.disable(), true);
  assert.deepEqual(h.geo.clearWatchCalls, [1]);
  assert.equal(readMyLocationState().status, 'off');
  assert.equal(h.controller.dataSource.entities.values.length, 0);

  h.controller.enable();
  h.eventTarget.dispatch('pagehide');
  assert.deepEqual(h.geo.clearWatchCalls, [1, 2]);
});

test('permission denial reports a retryable message without leaving the control loading', () => {
  const h = createHarness();
  h.controller.enable();
  h.geo.calls[0].error({ code: 1 });
  assert.equal(readMyLocationState().enabled, false);
  assert.equal(readMyLocationState().status, 'denied');
  assert.match(readMyLocationState().message, /allow it in your browser/i);
});

test('controller recreation rehydrates the existing browser-side location marker state', () => {
  const h = createHarness();
  h.controller.enable();
  h.geo.calls[0].success({
    coords: { latitude: 30.2672, longitude: -97.7431, accuracy: 30 },
    timestamp: 101,
  });
  h.controller.destroy();
  assert.equal(readMyLocationState().status, 'ready');
  const rebuilt = new MyLocationController({
    viewer: h.viewer,
    geolocation: h.geo,
    eventTarget: h.eventTarget,
    render: { governorRequestRender() {} },
  });
  assert.equal(readMyLocationState().status, 'ready');
  assert.equal(h.geo.calls.length, 2);
  assert.equal(rebuilt.dataSource.entities.values.length, 1);
});

test('transient watch errors clear stale entities until a fresh fix arrives', () => {
  const h = createHarness();
  h.controller.enable();
  h.geo.calls[0].success({
    coords: { latitude: 30.2672, longitude: -97.7431, accuracy: 30 },
    timestamp: 101,
  });
  assert.equal(h.controller.dataSource.entities.values.length, 1);
  h.geo.calls[0].error({ code: 3 });
  assert.equal(readMyLocationState().status, 'timeout');
  assert.equal(h.controller.dataSource.entities.values.length, 0);
});
