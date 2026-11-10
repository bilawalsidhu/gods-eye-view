// Edge cases for the local-adsb layer:
// a scene switch does not reopen the USB device, decoder stream or tuner
// permission; an unplugged device ends exactly one session; and no local ID
// reaches a public share link.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { createLocalAdsbLayer } from './index.js';
import { createLocalReceiverFeeds } from './feeds.js';
import { aircraftAtlasLayout } from '../aircraft/render/display.js';
import { createLocalAdsbDisplay } from './render/display.js';
import * as selection from '../../data/selectionDispatcher.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { readShareFollowSubject } from '../../ui/shareFollow.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fakeReceiver(initial = {}) {
  const state = {
    webUsbSupported: true,
    connected: true,
    mode: 'fm',
    status: 'streaming',
    message: 'Streaming',
    aircraft: [],
    messagesPerSecond: 40,
    ...initial,
  };
  const subscribers = new Set();
  const snapshot = () => ({ ...state, aircraft: [...state.aircraft] });
  const receiver = {
    modeCalls: [],
    connects: 0,
    closes: 0,
    getState: snapshot,
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    set(patch) {
      Object.assign(state, patch);
      for (const listener of subscribers) listener(snapshot());
    },
    async setMode(mode) {
      receiver.modeCalls.push(mode);
      state.mode = mode;
      return true;
    },
    async connect() {
      receiver.connects += 1;
      return true;
    },
    destroy() {
      receiver.closes += 1;
    },
  };
  return receiver;
}

function fakeFeeds() {
  let state = { configured: true, polling: false, feeds: [], records: [] };
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      calls.push('start');
      state = { ...state, polling: true };
    },
    stop() {
      calls.push('stop');
      state = { ...state, polling: false };
    },
    destroy() {
      calls.push('destroy');
    },
  };
}

const layout = aircraftAtlasLayout();
const drawAtlas = async () => ({
  canvas: { width: layout.width, height: layout.height },
  cells: layout.cells,
});

function fakeServices(registered = []) {
  let selected = null;
  return {
    render: { governorRequestRender() {} },
    context: {
      registerEntityContext(entity, metadata) {
        entity.__gevContextId = metadata.id;
        if (!registered.includes(entity)) registered.push(entity);
      },
      selectEntityContext(entity) {
        selected = { id: entity.__gevContextId, entity };
        return selected;
      },
      clearSelectedEntityContextForLayer() {
        selected = null;
      },
      getSelectedEntityContext: () => selected,
      removeEntityContextsForLayer() {},
    },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
    selection,
    // The layer's display (on a fake engine).
    renderer: {
      create: ({ engine }) => createLocalAdsbDisplay(engine, { drawAtlas }),
    },
    detection: { markSourcesChanged() {} },
    overlays: { refreshReadout() {} },
  };
}

function record(overrides = {}) {
  return {
    icao: 'abc123',
    callsign: 'LOCAL1',
    lat: 0,
    lon: 0,
    altitudeFt: 10_000,
    groundSpeedKt: 180,
    trackDeg: 0,
    verticalRateFpm: 0,
    lastPositionAt: 100_000,
    lastMessageAt: 100_000,
    messageCount: 12,
    rssiDbfs: null,
    band: '1090',
    source: 'webusb',
    ...overrides,
  };
}

test('edge:local-adsb: an unplugged receiver ends one session and a scene switch reopens nothing', async (t) => {
  const receiver = fakeReceiver({ aircraft: [record()] });
  const feeds = fakeFeeds();
  const clock = { now: 100_000 };
  const layer = createLocalAdsbLayer({
    receiver,
    feeds,
    services: fakeServices(),
    now: () => clock.now,
  });
  layer.init(null, { engine: createFakeEngine() });
  await layer.enable();
  assert.ok(layer.selectAircraft('abc123'));

  // The device is unplugged: the receiver reports it closed its session.
  receiver.set({
    connected: false,
    status: 'error',
    message: 'Device disconnected',
    aircraft: [],
    messagesPerSecond: null,
  });
  await layer.update();

  // The scene is swapped while the device is gone.
  layer.detachRenderer();
  clock.now += 1_000;
  await layer.update();
  layer.attachRenderer({ engine: createFakeEngine() });
  await layer.update();

  assert.deepEqual(receiver.modeCalls, ['adsb'], 'the tuner is asked once');
  assert.equal(receiver.connects, 0, 'the USB device is not reopened');
  assert.deepEqual(
    feeds.calls,
    ['start'],
    'the decoder stream is not restarted',
  );
  assert.equal(receiver.closes, 0, 'the layer leaves the session to its owner');

  layer.destroy();
  assert.equal(receiver.closes, 1, 'teardown closes exactly one session');
  assert.deepEqual(feeds.calls, ['start', 'destroy']);
});

test('edge:local-adsb: a decoder feed that disconnects keeps one polling loop across re-attaches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  let reachable = true;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (!reachable) throw new TypeError('receiver unplugged');
    return {
      ok: true,
      json: async () => ({
        configured: true,
        generatedAt: 1_000_000,
        feeds: [{ band: '1090', label: '1090 MHz', status: 'live' }],
        records: [],
      }),
    };
  };
  const feeds = createLocalReceiverFeeds({ fetchImpl, now: () => 1_000_000 });
  feeds.start();
  await flush();
  reachable = false;
  for (let tick = 0; tick < 3; tick += 1) {
    // A scene re-attach asks the session to start again while it polls.
    feeds.start();
    t.mock.timers.tick(1_000);
    await flush();
  }
  assert.equal(calls.length, 4, 'one request per interval, not one per start');
  assert.equal(feeds.getState().feeds[0].status, 'unreachable');
  assert.equal(feeds.getState().polling, true);
  feeds.stop();
  t.mock.timers.tick(5_000);
  await flush();
  assert.equal(calls.length, 4, 'stop ends the only loop');
});

test('edge:local-adsb: a selected local aircraft never reaches a share link', async (t) => {
  const receiver = fakeReceiver({
    mode: 'adsb',
    aircraft: [record({ lat: 10, lon: 20 })],
  });
  const registered = [];
  const layer = createLocalAdsbLayer({
    receiver,
    feeds: fakeFeeds(),
    services: fakeServices(registered),
    now: () => 100_000,
  });
  t.after(() => layer.destroy());
  layer.init(null, { engine: createFakeEngine() });
  await layer.enable();
  assert.ok(layer.selectAircraft('abc123'));
  const marker = registered.find((entity) =>
    String(entity.gevTrackedId || '').startsWith('local-adsb:'),
  );
  assert.ok(marker, 'the local marker carries its tracked id');

  const engine = createFakeEngine();
  const options = { native: marker, position: marker.gevDisplayPosition,
    viewFrom: { x: 0, y: -1000, z: 500 } };
  engine.camera.follow(options);
  engine.fake.frame();
  assert.equal(readShareFollowSubject({ engine }), null);
  engine.camera.follow({ ...options, native: {
    gevTrackedId: 'flights:abc123',
  } });
  engine.fake.frame();
  assert.equal(readShareFollowSubject({ engine })?.id, 'abc123');
  engine.destroy();
});
