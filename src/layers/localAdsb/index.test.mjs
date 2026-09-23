import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { CLASS_SCALE_2D } from '../../data/aircraftClass.js';
import { layerFeedState } from '../../data/feedState.js';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import {
  createLocalAdsbLayer,
  HEARD_BY_RECEIVER,
  localAdsbCardModel,
  localAdsbReceiverLine,
  localAdsbStatus,
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
      entities: {
        add: (entity) => entity,
        remove() {},
      },
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
    band: '1090',
    source: 'webusb',
    ...overrides,
  };
}

function fakeFeeds(initial = {}) {
  let state = {
    configured: null,
    polling: false,
    feeds: [],
    records: [],
    ...initial,
  };
  const listeners = new Set();
  const calls = [];
  return {
    calls,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(patch) {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    },
    start() {
      calls.push('start');
      state = { ...state, polling: true };
    },
    stop() {
      calls.push('stop');
      state = { ...state, polling: false };
    },
  };
}

/** A viewer whose camera looks down on (0°, 0°) from 50 km, with primitives. */
function modelViewer(primitives) {
  const base = fakeViewer();
  const camera = {
    ...base.viewer.camera,
    positionWC: new Cesium.Cartesian3(6_378_137 + 50_000, 0, 0),
    positionCartographic: new Cesium.Cartographic(0, 0, 50_000),
    directionWC: new Cesium.Cartesian3(-1, 0, 0),
    frustum: {
      computeCullingVolume: () => ({
        computeVisibility: () => Cesium.Intersect.INSIDE,
      }),
    },
  };
  return {
    ...base,
    viewer: {
      ...base.viewer,
      camera,
      scene: {
        camera,
        primitives: {
          add(collection) {
            primitives.push(collection);
            return collection;
          },
          remove() {},
        },
      },
    },
  };
}

async function enabledLayer(receiver, clock, feeds = null, options = {}) {
  const { services, calls } = fakeServices();
  const { sources, viewer } = options.viewer || fakeViewer();
  const layer = createLocalAdsbLayer({
    receiver,
    feeds,
    services: { ...services, ...options.services },
    now: () => clock.now,
    loadModel: options.loadModel,
  });
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

test('local aircraft use their class silhouette and scale in magenta', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, sources } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({
    aircraft: [record(), record({ icao: 'a0b702', category: 'A7' })],
  });
  await layer.update();

  const entity = sources[0].entities.getById('local-adsb:abc123');
  assert.ok(entity);
  assert.equal(entity.point, undefined);
  assert.equal(entity.label, undefined);
  assert.equal(entity.billboard.image.getValue(), aircraftIcon('airliner'));
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

  const heli = sources[0].entities.getById('local-adsb:a0b702');
  assert.equal(heli.billboard.image.getValue(), aircraftIcon('helicopter'));
  assert.equal(heli.billboard.scale.getValue(), CLASS_SCALE_2D.helicopter);
  assert.ok(
    Cesium.Color.equals(
      heli.billboard.color.getValue(),
      Cesium.Color.fromCssColorString('#ff4fd8'),
    ),
    'the helicopter keeps the local magenta',
  );
  assert.equal(heli.gevLabelModel.details[1], 'Helicopter · A7');

  // On the ground the silhouette shrinks like a grounded public flight.
  receiver.set({
    aircraft: [
      record({
        icao: 'a0b702',
        category: 'A7',
        onGround: true,
        lastPositionAt: 100_500,
      }),
    ],
  });
  await layer.update();
  assert.equal(
    heli.billboard.scale.getValue(),
    CLASS_SCALE_2D.helicopter * 0.8,
  );

  const [detectable] = layer.getDetectableObjects();
  assert.equal(detectable.sourceId, 'a0b702');
  assert.equal(detectable.type, 'AIR');
});

test('the heading slews toward a new track instead of snapping', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, sources } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record()] });
  await layer.update();
  const entity = sources[0].entities.getById('local-adsb:abc123');
  assert.equal(entity.billboard.rotation.getValue(), 0);

  clock.now = 101_000;
  receiver.set({
    aircraft: [
      record({
        lat: 0.0008,
        trackDeg: 90,
        lastPositionAt: 101_000,
        lastMessageAt: 101_000,
      }),
    ],
  });
  await layer.update();
  const first = entity.billboard.rotation.getValue();
  assert.ok(
    first > -Cesium.Math.PI_OVER_TWO && first <= 0,
    'one frame does not swing the nose 90°',
  );
  for (let frame = 0; frame < 12; frame += 1) {
    clock.now += 250;
    await layer.update();
  }
  assert.ok(
    Math.abs(entity.billboard.rotation.getValue() + Cesium.Math.PI_OVER_TWO) <
      1e-6,
    'the nose settles on the new track',
  );
});

test('markers move in real time between fixes and never jump on a new fix', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, sources } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  const latitude = () =>
    Cesium.Math.toDegrees(
      Cesium.Cartographic.fromCartesian(
        sources[0].entities.getById('local-adsb:abc123').position.getValue(),
      ).latitude,
    );
  // 180 kt due north: 1 s covers 92.6 m, 0.000833° of latitude.
  const degPerSecond = (180 * 1852) / 3600 / 111_195;
  receiver.set({ aircraft: [record({ lastPositionAt: 99_000 })] });
  await layer.update();
  assert.ok(
    Math.abs(latitude() - degPerSecond) < 1e-5,
    'drawn where the aircraft is now, not at its last fix (no display delay)',
  );
  clock.now = 100_500;
  await layer.update();
  assert.ok(Math.abs(latitude() - 1.5 * degPerSecond) < 1e-5);

  // The next fix is 150 m behind the extrapolation; the marker slides.
  const before = latitude();
  receiver.set({
    aircraft: [
      record({
        lat: before - 150 / 111_195,
        lastPositionAt: 100_500,
        lastMessageAt: 100_500,
      }),
    ],
  });
  await layer.update();
  assert.ok(Math.abs(latitude() - before) < 1e-7, 'no jump at the new fix');
  clock.now = 101_500;
  await layer.update();
  assert.ok(
    Math.abs(latitude() - (before - 150 / 111_195 + degPerSecond)) < 1e-5,
    'the correction has decayed onto the new fix',
  );
});

test('an implausible jump in a feed record is ignored by the display', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, sources } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record({ groundSpeedKt: 120, trackDeg: 0 })] });
  await layer.update();
  clock.now = 101_000;
  receiver.set({
    aircraft: [
      record({
        lat: 0.05,
        groundSpeedKt: 120,
        lastPositionAt: 101_000,
        lastMessageAt: 101_000,
      }),
    ],
  });
  await layer.update();
  const lat = Cesium.Math.toDegrees(
    Cesium.Cartographic.fromCartesian(
      sources[0].entities.getById('local-adsb:abc123').position.getValue(),
    ).latitude,
  );
  assert.ok(lat < 0.001, `stayed on its track (${lat})`);
  assert.equal(layer.getStats().rejectedPositions, 1);
});

test('selecting an aircraft draws a magenta trail of the fixes the receiver heard', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const trails = [];
  const { layer } = await enabledLayer(receiver, clock, null, {
    services: {
      trails: {
        createTrail(viewer, options) {
          const trail = { options, positions: [], destroyed: false };
          trails.push(trail);
          return {
            setPositions: (positions) => (trail.positions = positions),
            destroy: () => (trail.destroyed = true),
          };
        },
      },
    },
  });
  t.after(() => layer.destroy());
  for (let second = 0; second < 4; second += 1) {
    clock.now = 100_000 + second * 1_000;
    receiver.set({
      aircraft: [
        record({
          lat: second * 0.0008,
          lastPositionAt: clock.now,
          lastMessageAt: clock.now,
        }),
      ],
    });
    await layer.update();
    if (second === 1) assert.equal(layer.selectAircraft('abc123'), true);
  }
  assert.equal(trails.length, 1);
  assert.equal(trails[0].options.color, '#ff4fd8');
  assert.equal(trails[0].options.width, 2.5);
  assert.equal(trails[0].positions.length, 4, 'every heard fix, oldest first');
  assert.ok(
    Cesium.Cartographic.fromCartesian(trails[0].positions[0]).latitude <
      Cesium.Cartographic.fromCartesian(trails[0].positions[3]).latitude,
  );
  clock.now = 200_000;
  await layer.update();
  assert.equal(trails[0].destroyed, true, 'the trail leaves with the aircraft');
});

test('adsbdb type, operator and route reach the card for the selected aircraft only', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const queries = [];
  const { layer, sources } = await enabledLayer(receiver, clock, null, {
    services: {
      enrichment: {
        async getEnrichment(query) {
          queries.push(`${query.kind}:${query.id}`);
          if (query.kind === 'type')
            return { found: true, typeCode: 'B407', typeName: 'Bell 407' };
          return {
            found: true,
            airline: 'Air Evac',
            origin: { code: 'AUS', lat: 0.1, lon: 0 },
            destination: { code: 'SAT', lat: -0.1, lon: 0 },
          };
        },
      },
    },
  });
  t.after(() => layer.destroy());
  receiver.set({
    aircraft: [
      record({ icao: 'a0b702', callsign: 'EVC145', category: 'A7' }),
      record({ icao: 'def456', callsign: 'OTHER1' }),
    ],
  });
  await layer.update();
  assert.deepEqual(queries, [], 'no request per contact');
  assert.equal(layer.selectAircraft('a0b702'), true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual([...queries].sort(), ['route:EVC145', 'type:a0b702']);
  const entity = sources[0].entities.getById('local-adsb:a0b702');
  assert.deepEqual(entity.gevLabelModel.details.slice(0, 4), [
    'ICAO A0B702 · EVC145',
    'Helicopter · A7',
    'Air Evac · Bell 407',
    'AUS → SAT',
  ]);
  assert.equal(
    entity.gevLabelModel.details.at(-1),
    'Heard by your receiver · 1090 MHz · browser SDR',
  );
  layer.selectAircraft('a0b702');
  await layer.update();
  assert.equal(queries.length, 2, 'each key is asked for once');
});

test('the DISPLAY 3D toggle gives local aircraft magenta class models', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const loads = [];
  const display = { models3d: true, models3dMode: 'proximity' };
  const primitives = [];
  const { layer, sources } = await enabledLayer(receiver, clock, null, {
    services: { display: { getParams: () => display } },
    viewer: modelViewer(primitives),
    loadModel: async (options) => {
      const model = {
        ...options,
        ready: true,
        show: true,
        modelMatrix: new Cesium.Matrix4(),
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
        isDestroyed() {
          return this.destroyed;
        },
        update() {},
      };
      loads.push(model);
      return model;
    },
  });
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record({ icao: 'a0b702', category: 'A7' })] });
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  await layer.update();
  assert.equal(loads.length, 1);
  const [model] = loads;
  assert.equal(
    model.url,
    '/models/bell206.glb',
    'the Flights helicopter model',
  );
  assert.equal(model.scale, 1);
  assert.equal(model.id, 'local-adsb:a0b702');
  assert.ok(
    Cesium.Color.equals(
      model.color,
      Cesium.Color.fromCssColorString('#ff4fd8'),
    ),
  );
  assert.equal(model.colorBlendMode, Cesium.ColorBlendMode.MIX);
  assert.equal(model.colorBlendAmount, 0.94);
  assert.equal(model.show, true);
  const heli = sources[0].entities.getById('local-adsb:a0b702');
  assert.equal(
    heli.billboard.show.getValue(),
    false,
    'the model is the visual',
  );
  const origin = Cesium.Matrix4.getTranslation(
    model.modelMatrix,
    new Cesium.Cartesian3(),
  );
  assert.ok(Cesium.Cartesian3.distance(origin, heli.position.getValue()) < 1);

  display.models3d = false;
  await layer.update();
  assert.equal(model.destroyed || !primitives[0].contains(model), true);
  assert.equal(heli.billboard.show.getValue(), true, 'the billboard is back');
});

test('markers drop when the position is 60 s old and records when silent 60 s', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, sources } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({
    aircraft: [
      record(),
      record({
        icao: 'def456',
        callsign: '   ',
        lat: null,
        lon: null,
        lastPositionAt: null,
      }),
    ],
  });
  await layer.update();
  const entities = () => sources[0].entities.values.map((entity) => entity.id);
  assert.deepEqual(
    entities(),
    ['local-adsb:abc123'],
    'only positioned aircraft draw',
  );
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
  assert.deepEqual(calls.cleared, [{ layerId: 'local-adsb', evicted: true }]);
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
    'Heard by your receiver · 1090 MHz · browser SDR',
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
  const layer = createLocalAdsbLayer({
    receiver,
    services,
    now: () => clock.now,
  });
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

test('the receiver line names every band and source that heard the aircraft', () => {
  const line = (overrides) => localAdsbReceiverLine(record(overrides));
  assert.equal(line({}), 'Heard by your receiver · 1090 MHz · browser SDR');
  assert.equal(
    line({ band: '1090', source: 'feed' }),
    'Heard by your receiver · 1090 MHz · decoder feed',
  );
  assert.equal(
    line({ band: '978', source: 'feed' }),
    'Heard by your receiver · 978 MHz UAT · decoder feed',
  );
  assert.equal(
    line({ bands: ['1090', '978'], sources: ['feed'] }),
    'Heard by your receiver · 1090 MHz + 978 MHz UAT · decoder feed',
  );
  assert.equal(
    line({ bands: ['1090'], sources: ['webusb', 'feed'] }),
    'Heard by your receiver · 1090 MHz · browser SDR + decoder feed',
  );
  assert.equal(
    line({ bands: ['1090', '978'], sources: ['webusb', 'feed'] }),
    'Heard by your receiver · 1090 MHz + 978 MHz UAT · browser SDR + decoder feed',
  );
  assert.equal(
    localAdsbReceiverLine({ icao: 'abc123' }),
    HEARD_BY_RECEIVER,
    'a record without band or source keeps the plain line',
  );
});

test('feed records merge with browser SDR records by ICAO and UAT-only aircraft get a ring', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const feeds = fakeFeeds();
  const clock = { now: 100_000 };
  const { layer, sources } = await enabledLayer(receiver, clock, feeds);
  t.after(() => layer.destroy());
  assert.deepEqual(feeds.calls, ['start'], 'the feeds poll while enabled');

  receiver.set({ aircraft: [record({ lastPositionAt: 98_000 })] });
  feeds.set({
    configured: true,
    feeds: [{ band: '978', label: '978 MHz UAT', status: 'live' }],
    records: [
      record({ lat: 1, band: '978', source: 'feed', lastPositionAt: 99_000 }),
      record({
        icao: 'a1b2c3',
        callsign: 'N978UA',
        band: '978',
        source: 'feed',
      }),
    ],
  });
  await layer.update();
  const shared = sources[0].entities.getById('local-adsb:abc123');
  const uat = sources[0].entities.getById('local-adsb:a1b2c3');
  assert.equal(sources[0].entities.values.length, 2);
  assert.equal(
    Cesium.Cartographic.fromCartesian(
      shared.position.getValue(),
    ).latitude.toFixed(4),
    Cesium.Math.toRadians(1).toFixed(4),
    'the newer feed position wins',
  );
  assert.equal(shared.point, undefined, 'heard on 1090 too: no UAT ring');
  assert.equal(
    shared.gevLabelModel.details.at(-1),
    'Heard by your receiver · 1090 MHz + 978 MHz UAT · browser SDR + decoder feed',
  );
  assert.ok(uat.point, 'a UAT-only aircraft carries the ring');
  assert.equal(uat.point.outlineWidth.getValue(), 1.5);
  assert.ok(
    Cesium.Color.equals(uat.point.color.getValue(), Cesium.Color.TRANSPARENT),
  );
  assert.ok(
    Cesium.Color.equals(
      uat.billboard.color.getValue(),
      Cesium.Color.fromCssColorString('#ff4fd8'),
    ),
    'same magenta marker family',
  );
  assert.equal(
    uat.gevLabelModel.details.at(-1),
    'Heard by your receiver · 978 MHz UAT · decoder feed',
  );
  const stats = layer.getStats();
  assert.equal(stats.source, 'WebUSB + decoder feeds');
  assert.equal(stats.loadingLabel, '1 feed live · 2 heard');
  assert.equal(stats.count, 2);

  await layer.disable();
  assert.deepEqual(feeds.calls, ['start', 'stop']);
});

test('row status reflects decoder feeds and the browser SDR together', () => {
  const idle = {
    webUsbSupported: true,
    connected: false,
    mode: 'fm',
    status: 'idle',
  };
  const usb = {
    ...idle,
    connected: true,
    mode: 'adsb',
    status: 'streaming',
    messagesPerSecond: 3.5,
  };
  const feedState = (...statuses) => ({
    configured: true,
    polling: true,
    feeds: statuses.map(([band, status]) => ({
      band,
      label: band,
      status,
    })),
  });
  const status = (receiver, feeds, heard = 14) =>
    localAdsbStatus({ receiver, feedState: feeds, heard });

  // No feeds configured: the WebUSB statuses are unchanged.
  assert.deepEqual(status(idle, null), {
    source: 'RTL-SDR · WebUSB',
    status: 'idle',
    statusMessage: 'connect a receiver in Radio',
  });
  assert.deepEqual(
    status(idle, { configured: false, feeds: [], polling: false }),
    status(idle, null),
  );
  assert.equal(status(usb, null).loadingLabel, '14 heard · 3.5 msg/s');
  assert.equal(
    status(idle, { configured: null, polling: true, feeds: [] }).loadingLabel,
    'checking decoder feeds',
  );

  let stats = status(idle, feedState(['1090', 'live'], ['978', 'live']));
  assert.deepEqual(stats, {
    source: 'Decoder feeds',
    status: 'streaming',
    loadingLabel: '2 feeds live · 14 heard',
  });
  stats = status(usb, feedState(['978', 'live']));
  assert.equal(stats.source, 'WebUSB + decoder feeds');
  assert.equal(stats.loadingLabel, '1 feed live · 14 heard · USB 3.5 msg/s');

  stats = status(idle, feedState(['1090', 'live'], ['978', 'unreachable']), 9);
  assert.equal(stats.degraded, true);
  assert.equal(stats.loadingLabel, 'feed 978 unreachable · 9 heard');

  stats = status(idle, feedState(['978', 'unreachable']), 0);
  assert.equal(stats.status, 'error');
  assert.equal(stats.error, 'feed 978 unreachable');
  stats = status(
    usb,
    feedState(['1090', 'stale'], ['978', 'stale'], ['1090', 'invalid']),
  );
  assert.equal(stats.degraded, true);
  assert.equal(
    stats.loadingLabel,
    'feeds 1090 #1, 978 stale · feed 1090 #2 invalid · 14 heard · USB 3.5 msg/s',
  );
});

test('every feed stale reads STALE, not an error; unreachable stays an error', () => {
  const idle = {
    webUsbSupported: true,
    connected: false,
    mode: 'fm',
    status: 'idle',
  };
  const feedState = (...feeds) => ({
    configured: true,
    polling: true,
    feeds: feeds.map(([band, status, label = band]) => ({
      band,
      label,
      status,
    })),
  });
  const status = (feeds, heard = 3) =>
    localAdsbStatus({ receiver: idle, feedState: feeds, heard });

  // A decoder that stopped but still serves its last aircraft.json.
  let stats = status(feedState(['1090', 'stale'], ['978', 'stale']));
  assert.equal(stats.status, 'stale');
  assert.equal(stats.error, undefined);
  assert.equal(layerFeedState(stats), 'stale');
  assert.equal(stats.statusMessage, 'feeds 1090, 978 stale · 3 heard');

  // An invalid entry is a configuration note, not a reason to fail the row.
  stats = status(feedState(['1090', 'stale'], ['978', 'invalid']), 0);
  assert.equal(layerFeedState(stats), 'stale');

  stats = status(feedState(['1090', 'stale'], ['978', 'unreachable']), 0);
  assert.equal(stats.status, 'error');
  assert.equal(layerFeedState(stats), 'unavailable');
  stats = status(feedState(['978', 'invalid']), 0);
  assert.equal(stats.status, 'error');
});

test('row status names two same-band feeds by their ordinal labels', () => {
  const stats = localAdsbStatus({
    receiver: {
      webUsbSupported: true,
      connected: false,
      mode: 'fm',
      status: 'idle',
    },
    feedState: {
      configured: true,
      polling: true,
      feeds: [
        { band: '978', label: '978 MHz UAT #1', status: 'live' },
        { band: '978', label: '978 MHz UAT #2', status: 'unreachable' },
        { band: '1090', label: '1090 MHz', status: 'unreachable' },
      ],
    },
    heard: 4,
  });
  assert.equal(
    stats.loadingLabel,
    'feeds 978 MHz UAT #2, 1090 unreachable · 4 heard',
  );
});

function fakeModel(options) {
  return {
    ...options,
    ready: true,
    show: true,
    modelMatrix: new Cesium.Matrix4(),
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    isDestroyed() {
      return this.destroyed;
    },
    update() {},
  };
}

test('the last aircraft expiring removes its 3D model and cancels a pending load', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const primitives = [];
  const loads = [];
  const deferred = [];
  const { layer } = await enabledLayer(receiver, clock, null, {
    services: {
      display: {
        getParams: () => ({ models3d: true, models3dMode: 'proximity' }),
      },
    },
    viewer: modelViewer(primitives),
    loadModel: (options) => {
      const model = fakeModel(options);
      loads.push(model);
      if (options.id === 'local-adsb:abc123') return Promise.resolve(model);
      return new Promise((resolve) => deferred.push(() => resolve(model)));
    },
  });
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record({ category: 'A7' })] });
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));
  await layer.update();
  const [model] = loads;
  assert.equal(model.show, true, 'the model is the visual');
  assert.ok(primitives[0].contains(model));

  // Its position ages out: no markers remain, so no per-frame model pass.
  clock.now = 160_000;
  await layer.update();
  assert.equal(
    model.destroyed || !primitives[0].contains(model),
    true,
    'the expired aircraft leaves no model behind',
  );

  // A load still in flight when its aircraft expires is never admitted.
  clock.now = 200_000;
  receiver.set({
    aircraft: [
      record({
        icao: 'def456',
        lastPositionAt: 200_000,
        lastMessageAt: 200_000,
      }),
    ],
  });
  await layer.update();
  clock.now = 260_000;
  await layer.update();
  assert.equal(deferred.length, 1, 'a load was in flight');
  deferred[0]();
  await new Promise((resolve) => setImmediate(resolve));
  const late = loads.at(-1);
  assert.equal(late.id, 'local-adsb:def456');
  assert.equal(primitives[0].contains(late), false);
  assert.equal(late.destroyed, true);
});
