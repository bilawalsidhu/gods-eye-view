import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import {
  createLocalAdsbLayer,
  HEARD_BY_RECEIVER,
  localAdsbCardModel,
} from './index.js';

function fakeReceiver(initial = {}) {
  const state = {
    webUsbSupported: true,
    connected: false,
    mode: 'fm',
    status: 'idle',
    message: 'Ready',
    aircraft: [],
    messagesPerSecond: null,
    ...initial,
  };
  const modeCalls = [];
  const subscribers = new Set();
  const snapshot = () => ({ ...state, aircraft: [...state.aircraft] });
  return {
    modeCalls,
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
      modeCalls.push(mode);
      state.mode = mode;
      return true;
    },
  };
}

function fakeServices() {
  const calls = { registered: [], selected: [], cleared: [], removed: [] };
  let selected = null;
  return {
    calls,
    services: {
      render: { governorRequestRender() {} },
      context: {
        registerEntityContext(entity, metadata) {
          entity.__gevContextId = metadata.id;
          calls.registered.push(metadata);
        },
        selectEntityContext(entity) {
          selected = { id: entity.__gevContextId, entity };
          calls.selected.push(selected.id);
          return selected;
        },
        clearSelectedEntityContextForLayer(layerId, options) {
          calls.cleared.push({ layerId, ...options });
          selected = null;
        },
        getSelectedEntityContext: () => selected,
        removeEntityContextsForLayer(layerId, options) {
          calls.removed.push({ layerId, retainIds: options?.retainIds });
        },
      },
      picking: { registerPickOwner() {}, unregisterPickOwner() {} },
      detection: { markSourcesChanged() {} },
      overlays: { refreshReadout() {} },
    },
  };
}

function fakeViewer() {
  const sources = [];
  const camera = {
    rightWC: new Cesium.Cartesian3(0, 1, 0),
    upWC: new Cesium.Cartesian3(0, 0, 1),
  };
  return {
    sources,
    viewer: {
      camera,
      scene: { camera },
      dataSources: {
        add(source) {
          sources.push(source);
        },
        remove() {},
      },
    },
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
    source: 'rtl-sdr',
    ...overrides,
  };
}

async function enabledLayer(receiver, clock) {
  const { services, calls } = fakeServices();
  const { sources, viewer } = fakeViewer();
  const layer = createLocalAdsbLayer({ receiver, services, now: () => clock.now });
  layer.init(viewer);
  await layer.enable();
  return { layer, calls, sources };
}

test('enabling Local ADS-B asks the shared tuner for 1090 MHz; disabling leaves it alone', async (t) => {
  const receiver = fakeReceiver({ mode: 'fm' });
  const clock = { now: 0 };
  const { layer } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  assert.equal(layer.id, 'local-adsb');
  assert.equal(layer.name, 'Local ADS-B');
  assert.deepEqual(receiver.modeCalls, ['adsb']);
  assert.equal(await layer.disable(), true);
  assert.deepEqual(
    receiver.modeCalls,
    ['adsb'],
    'turning the layer off never starts FM audio on its own',
  );
});

test('local aircraft use the live-flight silhouette in magenta', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, sources } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record()] });
  await layer.update();

  const entity = sources[0].entities.getById('local-adsb:abc123');
  assert.ok(entity);
  assert.equal(entity.point, undefined);
  assert.equal(entity.label, undefined);
  assert.match(entity.billboard.image.getValue(), /^data:image\/svg\+xml;base64,/);
  assert.equal(entity.billboard.width.getValue(), 20);
  assert.ok(
    Cesium.Color.equals(
      entity.billboard.color.getValue(),
      Cesium.Color.fromCssColorString('#ff4fd8'),
    ),
  );
  assert.ok(
    Cesium.Cartesian3.equals(
      entity.billboard.alignedAxis.getValue(),
      Cesium.Cartesian3.ZERO,
    ),
  );
  assert.equal(entity.billboard.rotation.getValue(), 0);
  assert.equal(entity.gevLabelModel.title, 'LOCAL1');
  assert.equal(typeof entity.gevDisplayPosition, 'function');

  const [detectable] = layer.getDetectableObjects();
  assert.equal(detectable.sourceId, 'abc123');
  assert.equal(detectable.id, 'LOCAL1');
  assert.equal(detectable.type, 'AIR');

  receiver.set({ aircraft: [record({ trackDeg: 90 })] });
  await layer.update();
  assert.ok(
    Math.abs(entity.billboard.rotation.getValue() + Cesium.Math.PI_OVER_TWO) <
      1e-9,
  );
});

test('markers drop when the position is 60 s old and records when silent 60 s', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, sources } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({
    aircraft: [
      record(),
      record({ icao: 'def456', callsign: '   ', lat: null, lon: null, lastPositionAt: null }),
    ],
  });
  await layer.update();
  const entities = () => sources[0].entities.values.map((entity) => entity.id);
  assert.deepEqual(entities(), ['local-adsb:abc123'], 'only positioned aircraft draw');
  assert.equal(layer.getStats().count, 1);

  // Still transmitting (no position) but the last position is 60 s old.
  receiver.set({ aircraft: [record({ lastMessageAt: 150_000 })] });
  clock.now = 159_999;
  await layer.update();
  assert.deepEqual(entities(), ['local-adsb:abc123']);
  clock.now = 160_000;
  await layer.update();
  assert.deepEqual(entities(), [], 'a stale position is not drawn');
  assert.deepEqual(layer.getDetectableObjects(), []);
});

test('selecting a marker publishes the readout card and eviction clears it', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, calls } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record()] });
  await layer.update();
  const metadata = calls.registered.at(-1);
  assert.equal(metadata.id, 'local-adsb:abc123');
  assert.equal(metadata.layerId, 'local-adsb');
  assert.equal(metadata.properties.icao, 'abc123');
  assert.equal(layer.selectAircraft('abc123'), true);
  assert.deepEqual(calls.selected, ['local-adsb:abc123']);
  assert.equal(layer.selectAircraft('ffffff'), false);

  clock.now = 200_000;
  await layer.update();
  assert.deepEqual(calls.cleared, [
    { layerId: 'local-adsb', evicted: true },
  ]);
  assert.equal(calls.removed.at(-1).layerId, 'local-adsb');
  assert.equal(calls.removed.at(-1).retainIds.size, 0);
});

test('the click card lists identity, kinematics, freshness and the receiver line', () => {
  const card = localAdsbCardModel(
    record({
      icao: 'ae5d8a',
      callsign: 'SHINR42',
      altitudeFt: 1600,
      groundSpeedKt: 129.9,
      trackDeg: 330.5,
      verticalRateFpm: 64,
      lastPositionAt: 96_000,
      messageCount: 48,
    }),
    100_000,
  );
  assert.equal(card.title, 'SHINR42');
  assert.equal(card.accent, '#ff4fd8');
  assert.deepEqual(card.details, [
    'ICAO AE5D8A · SHINR42',
    'ALT 1,600 FT · GS 130 KT · TRK 331°',
    'V/S +64 FPM',
    'POSITION 4 S AGO · 48 MSGS',
    HEARD_BY_RECEIVER,
  ]);
  assert.equal(HEARD_BY_RECEIVER, 'Heard by your receiver');
  const bare = localAdsbCardModel(
    record({
      callsign: null,
      altitudeFt: null,
      groundSpeedKt: null,
      trackDeg: null,
      verticalRateFpm: -1_280,
      messageCount: 1,
    }),
    100_000,
  );
  assert.equal(bare.title, 'ABC123');
  assert.deepEqual(bare.details.slice(0, 4), [
    'ICAO ABC123 · NO CALLSIGN',
    'ALT — FT · GS — KT · TRK —',
    'V/S -1,280 FPM',
    'POSITION 0 S AGO · 1 MSG',
  ]);
});

test('layer stats guide the operator to the Radio card until ADS-B is streaming', () => {
  const clock = { now: 100_000 };
  const { services } = fakeServices();
  const receiver = fakeReceiver();
  const layer = createLocalAdsbLayer({ receiver, services, now: () => clock.now });
  assert.equal(layer.getStats().statusMessage, 'connect a receiver in Radio');
  receiver.set({ connected: true, status: 'streaming', mode: 'fm' });
  assert.equal(layer.getStats().statusMessage, 'receiver is in FM mode');
  receiver.set({
    mode: 'adsb',
    messagesPerSecond: 3.5,
    aircraft: [record(), record({ icao: 'def456', lat: null, lon: null })],
  });
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.loadingLabel, '2 heard · 3.5 msg/s');
  receiver.set({ status: 'error', message: 'RTL-SDR sample stream stopped' });
  assert.equal(layer.getStats().error, 'RTL-SDR sample stream stopped');
  receiver.set({ status: 'idle', webUsbSupported: false, connected: false });
  assert.equal(
    layer.getStats().statusMessage,
    'WebUSB needs desktop Chrome or Edge',
  );
});
