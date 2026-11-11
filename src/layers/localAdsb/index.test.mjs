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
import { createLocalAdsbDisplay } from './render/display.js';
import { aircraftAtlasLayout } from '../aircraft/render/display.js';
import * as selection from '../../data/selectionDispatcher.js';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import * as geo from '../../geo/index.js';
import { rgbaFromCss } from '../shared/color.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';

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

const layout = aircraftAtlasLayout();
const drawAtlas = async () => ({
  canvas: { width: layout.width, height: layout.height },
  cells: layout.cells,
});
const MAGENTA = rgbaFromCss('#ff4fd8').rgba();
const rgba = (color) => [color.red, color.green, color.blue, color.alpha];
const near = (a, b, label) =>
  assert.ok(
    a.every((value, index) => Math.abs(value - b[index]) < 1e-6),
    `${label}: ${a} vs ${b}`,
  );
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeServices({ display = (engine) => engine } = {}) {
  // Marker handles by id, as the layer registers their context.
  const calls = {
    registered: [],
    selected: [],
    cleared: [],
    removed: [],
    markers: new Map(),
  };
  let selected = null;
  return {
    calls,
    services: {
      render: { governorRequestRender() {} },
      context: {
        registerEntityContext(entity, metadata) {
          entity.__gevContextId = metadata.id;
          calls.registered.push(metadata);
          calls.markers.set(metadata.id, entity);
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
      // As src/app/layers/localAdsb.js composes them: the layer's display
      // (on a fake engine), and the engine's selection dispatcher (clicks).
      selection,
      renderer: {
        create: ({ engine }) =>
          display(createLocalAdsbDisplay(engine, { drawAtlas })),
      },
      detection: { markSourcesChanged() {} },
      overlays: { refreshReadout() {} },
    },
  };
}

/** A fake engine whose camera looks down on (0°, 0°) from 50 km. */
function fakeEngine() {
  const engine = createFakeEngine();
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(0, 0, 50_000),
  });
  return engine;
}

/** The ids of the markers the display draws, and its sprite and ring sets. */
function drawn(engine) {
  const sets = engine.movers.list();
  const sprites = sets.find(({ id }) => id.startsWith('local-adsb-sprites'));
  const rings = sets.find(({ id }) => id.startsWith('local-adsb-rings'));
  const models = sets.find(({ id }) => id.startsWith('local-adsb-models'));
  const set = (listed) => (listed ? engine.fake.moverSet(listed.id) : null);
  return {
    ids: sprites ? set(sprites).store.pickIds.slice(0, sprites.count) : [],
    sprites: set(sprites),
    rings: set(rings),
    models: set(models),
    count: (listed) => listed?.count ?? 0,
    listed: { sprites, rings, models },
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

async function enabledLayer(receiver, clock, feeds = null, options = {}) {
  const { services, calls } = fakeServices(options);
  const engine = options.engine || fakeEngine();
  const layer = createLocalAdsbLayer({
    receiver,
    feeds,
    services: { ...services, ...options.services },
    now: () => clock.now,
  });
  layer.init(null, { engine });
  await layer.enable();
  const marker = (icao) => calls.markers.get(`local-adsb:${icao}`);
  return { layer, calls, engine, marker };
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
  const { layer, engine, marker } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({
    aircraft: [record(), record({ icao: 'a0b702', category: 'A7' })],
  });
  await layer.update();
  await settle();

  const entity = marker('abc123');
  assert.ok(entity);
  assert.equal(entity.ring, null, 'no UAT ring');
  assert.equal(entity.sprite.image, aircraftIcon('airliner'));
  assert.equal(entity.sprite.width, 20);
  near(rgba(entity.sprite.color), MAGENTA, 'magenta');
  // Screen-aligned glyphs over the scene, scaled with distance as Cesium's
  // billboards were.
  const { sprites } = drawn(engine);
  assert.equal(sprites.options.depthTest, 'always');
  assert.deepEqual(
    sprites.options.sprite.scaleByDistance,
    [1000, 3, 8_000_000, 0.5],
  );
  assert.equal(entity.spec.rotation(), 0);
  assert.equal(entity.gevLabelModel.title, 'LOCAL1');
  assert.equal(typeof entity.gevDisplayPosition, 'function');

  const heli = marker('a0b702');
  assert.equal(heli.sprite.image, aircraftIcon('helicopter'));
  assert.equal(heli.sprite.scale, CLASS_SCALE_2D.helicopter);
  near(
    rgba(heli.sprite.color),
    MAGENTA,
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
  assert.equal(heli.sprite.scale, CLASS_SCALE_2D.helicopter * 0.8);

  const [detectable] = layer.getDetectableObjects();
  assert.equal(detectable.sourceId, 'a0b702');
  assert.equal(detectable.type, 'AIR');
});

test('the heading slews toward a new track instead of snapping', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, marker } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record()] });
  await layer.update();
  const entity = marker('abc123');
  assert.equal(entity.spec.rotation(), 0);

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
  const first = entity.spec.rotation();
  assert.ok(
    first > -Cesium.Math.PI_OVER_TWO && first <= 0,
    'one frame does not swing the nose 90°',
  );
  for (let frame = 0; frame < 12; frame += 1) {
    clock.now += 250;
    await layer.update();
  }
  assert.ok(
    Math.abs(entity.spec.rotation() + Cesium.Math.PI_OVER_TWO) < 1e-6,
    'the nose settles on the new track',
  );
});

test('markers move in real time between fixes and never jump on a new fix', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, marker } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  const latitude = () =>
    Cesium.Math.toDegrees(
      Cesium.Cartographic.fromCartesian(marker('abc123').spec.position())
        .latitude,
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
  const { layer, marker } = await enabledLayer(receiver, clock);
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
    Cesium.Cartographic.fromCartesian(marker('abc123').spec.position())
      .latitude,
  );
  assert.ok(lat < 0.001, `stayed on its track (${lat})`);
  assert.equal(layer.getStats().rejectedPositions, 1);
});

test('selecting an aircraft draws a magenta trail of the fixes the receiver heard', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, engine } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  // The trail body (the head is its own line, `-head-`).
  const trails = () =>
    engine.lines
      .list()
      .filter(({ id }) => /^gev-trail:\d/.test(id))
      .map(({ id }) => engine.fake.line(id));
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
  const [trail] = trails();
  assert.equal(trails().length, 1);
  near(trail.options.color.slice(0, 3), MAGENTA.slice(0, 3), 'magenta');
  assert.equal(trail.options.widthPx, 2.5);
  const flat = trail.positions;
  assert.equal(flat.length / 3, 4, 'every heard fix, oldest first');
  const at = (index) =>
    Cesium.Cartographic.fromCartesian(
      new Cesium.Cartesian3(
        flat[index * 3],
        flat[index * 3 + 1],
        flat[index * 3 + 2],
      ),
    );
  assert.ok(at(0).latitude < at(3).latitude);
  clock.now = 200_000;
  await layer.update();
  assert.equal(trails().length, 0, 'the trail leaves with the aircraft');
});

test('adsbdb type, operator and route reach the card for the selected aircraft only', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const queries = [];
  const { layer, marker } = await enabledLayer(receiver, clock, null, {
    services: {
      // 3D off: a model-eligible aircraft is enriched for its class too.
      display: {
        getParams: () => ({ models3d: false, models3dMode: 'proximity' }),
      },
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
  const entity = marker('a0b702');
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
  const display = { models3d: true, models3dMode: 'proximity' };
  const { layer, engine, marker } = await enabledLayer(receiver, clock, null, {
    services: { display: { getParams: () => display } },
  });
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record({ icao: 'a0b702', category: 'A7' })] });
  await layer.update();
  await settle();
  await layer.update();
  await settle();
  const { models } = drawn(engine);
  assert.ok(models, 'a model set');
  assert.equal(
    models.options.model.url,
    '/models/bell206.glb',
    'the Flights helicopter model',
  );
  assert.deepEqual(models.options.model.colorBlend, {
    mode: 'mix',
    amount: 0.94,
  });
  assert.equal(models.store.count, 1);
  assert.equal(models.store.scales[0], 1);
  assert.equal(models.store.pickIds[0], 'local-adsb:a0b702');
  near([...models.store.colors.slice(0, 4)], MAGENTA, 'magenta');
  assert.equal(models.store.shows[0], 1, 'the model is drawn');
  const heli = marker('a0b702');
  assert.equal(heli.spec.show(), false, 'the model is the visual');
  const origin = new Cesium.Cartesian3(...models.store.positions.slice(0, 3));
  assert.ok(Cesium.Cartesian3.distance(origin, heli.spec.position()) < 1);

  display.models3d = false;
  await layer.update();
  await settle();
  assert.equal(drawn(engine).models.store.count, 0, 'the model is gone');
  assert.equal(heli.spec.show(), true, 'the billboard is back');
});

test('markers drop when the position is 60 s old and records when silent 60 s', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, engine } = await enabledLayer(receiver, clock);
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
  await settle();
  const entities = () => drawn(engine).ids;
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
  await settle();
  assert.deepEqual(entities(), [], 'a stale position is not drawn');
  assert.deepEqual(layer.getDetectableObjects(), []);
});

test('selectById selects a heard aircraft by the id its position rows carry, like a click', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, calls } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record()] });
  await layer.update();
  const [row] = layer.getAllPositions();
  assert.equal(row.id, 'abc123');
  assert.equal(layer.selectById(row.id), true);
  assert.equal(layer.selectById(' ABC123 '), true, 'any case, trimmed');
  assert.equal(layer.selectById('local-adsb:abc123'), true, 'the marker id');
  assert.deepEqual(calls.selected, [
    'local-adsb:abc123',
    'local-adsb:abc123',
    'local-adsb:abc123',
  ]);
  for (const missing of ['ffffff', '', null, undefined, 'local-adsb:'])
    assert.equal(layer.selectById(missing), false, String(missing));
  await layer.disable();
  assert.equal(layer.selectById('abc123'), false, 'nothing while off');
  assert.equal(calls.selected.length, 3);
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
  const { layer, engine, marker } = await enabledLayer(receiver, clock, feeds);
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
  await settle();
  const shared = marker('abc123');
  const uat = marker('a1b2c3');
  assert.equal(drawn(engine).ids.length, 2);
  assert.equal(
    Cesium.Cartographic.fromCartesian(shared.spec.position()).latitude.toFixed(
      4,
    ),
    Cesium.Math.toRadians(1).toFixed(4),
    'the newer feed position wins',
  );
  assert.equal(shared.ring, null, 'heard on 1090 too: no UAT ring');
  assert.equal(
    shared.gevLabelModel.details.at(-1),
    'Heard by your receiver · 1090 MHz + 978 MHz UAT · browser SDR + decoder feed',
  );
  assert.ok(uat.ring, 'a UAT-only aircraft carries the ring');
  const { rings } = drawn(engine);
  assert.equal(rings.store.count, 1);
  assert.equal(rings.store.pickIds[0], 'local-adsb:a1b2c3');
  assert.equal(rings.options.point.outlinePx, 1.5);
  assert.deepEqual([...rings.store.colors.slice(0, 4)], [0, 0, 0, 0]);
  near(rgba(uat.sprite.color), MAGENTA, 'same magenta marker family');
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

  // A live feed keeps the row nominal; the unreachable one is a trailing note.
  stats = status(idle, feedState(['1090', 'live'], ['978', 'unreachable']), 9);
  assert.deepEqual(stats, {
    source: 'Decoder feeds',
    status: 'streaming',
    loadingLabel: '9 heard · feed 978 unreachable',
  });
  assert.equal(layerFeedState(stats), 'nominal');

  stats = status(idle, feedState(['978', 'unreachable']), 0);
  assert.equal(stats.status, 'error');
  assert.equal(stats.error, 'feed 978 unreachable');
  stats = status(
    usb,
    feedState(['1090', 'stale'], ['978', 'stale'], ['1090', 'invalid']),
  );
  assert.equal(stats.status, 'streaming');
  assert.equal(stats.degraded, undefined);
  assert.equal(layerFeedState(stats), 'nominal');
  assert.equal(
    stats.loadingLabel,
    '14 heard · USB 3.5 msg/s · feeds 1090 #1, 978 stale · feed 1090 #2 invalid',
  );
});

test('a stale decoder feed does not mark a streaming browser receiver degraded', () => {
  // Owner field test: dump1090 stopped so the browser could take the dongle.
  const stats = localAdsbStatus({
    receiver: {
      webUsbSupported: true,
      connected: true,
      mode: 'adsb',
      status: 'streaming',
      messagesPerSecond: 5.8,
    },
    feedState: {
      configured: true,
      polling: true,
      feeds: [{ band: '1090', label: '1090 MHz', status: 'stale' }],
    },
    heard: 3,
  });
  assert.deepEqual(stats, {
    source: 'WebUSB + decoder feeds',
    status: 'streaming',
    loadingLabel: '3 heard · USB 5.8 msg/s · feed 1090 stale',
  });
  assert.equal(layerFeedState(stats), 'nominal');
});

test('a browser receiver error beside a live feed is a note on a nominal row', () => {
  const stats = localAdsbStatus({
    receiver: {
      webUsbSupported: true,
      connected: true,
      mode: 'adsb',
      status: 'error',
      message: 'RTL-SDR sample stream stopped',
    },
    feedState: {
      configured: true,
      polling: true,
      feeds: [{ band: '978', label: '978 MHz UAT', status: 'live' }],
    },
    heard: 2,
  });
  assert.equal(stats.status, 'streaming');
  assert.equal(layerFeedState(stats), 'nominal');
  assert.equal(stats.loadingLabel, '2 heard · USB error');
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
    '4 heard · feeds 978 MHz UAT #2, 1090 unreachable',
  );
});

test('the last aircraft expiring removes its 3D model and cancels a pending load', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const loads = [];
  const deferred = [];
  // The display's loads, the second held until the test lets it finish.
  const holdLoads = (display) => {
    const load = display.models.loadFleet;
    display.models.loadFleet = async (spec) => {
      const model = await load(spec);
      loads.push(model);
      if (spec.id === 'local-adsb:abc123') return model;
      return new Promise((resolve) => deferred.push(() => resolve(model)));
    };
    return display;
  };
  const { layer, engine } = await enabledLayer(receiver, clock, null, {
    display: holdLoads,
    services: {
      display: {
        getParams: () => ({ models3d: true, models3dMode: 'proximity' }),
      },
    },
  });
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record({ category: 'A7' })] });
  await layer.update();
  await settle();
  await layer.update();
  await settle();
  const [model] = loads;
  assert.equal(model.show, true, 'the model is the visual');
  assert.equal(drawn(engine).models.store.count, 1);

  // Its position ages out: no markers remain, so no per-frame model pass.
  clock.now = 160_000;
  await layer.update();
  await settle();
  assert.equal(
    drawn(engine).models.store.count,
    0,
    'the expired aircraft leaves no model behind',
  );
  assert.equal(model.gevBank, null);

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
  await settle();
  clock.now = 260_000;
  await layer.update();
  assert.equal(deferred.length, 1, 'a load was in flight');
  deferred[0]();
  await settle();
  const late = loads.at(-1);
  assert.equal(late.id, 'local-adsb:def456');
  assert.equal(late.gevBank, null, 'never admitted');
  assert.equal(drawn(engine).models.store.count, 0);
});

/**
 * A fake engine that scripts the picks under a click; clicks reach the layer
 * through the engine's selection dispatcher, as in the app.
 */
function clickHarness() {
  const engine = fakeEngine();
  const scene = { pickResult: null, drillResult: [] };
  engine.fake.script('pick', () => scene.pickResult ?? undefined);
  engine.fake.script('drillPick', () => scene.drillResult);
  return {
    scene,
    engine,
    release() {
      engine.destroy();
    },
    click() {
      engine.fake.input('down', { position: { x: 10, y: 10 } });
      engine.fake.input('up', { position: { x: 10, y: 10 } });
      engine.fake.input('click', { position: { x: 10, y: 10 } });
    },
  };
}

test('clicking the selected aircraft keeps it selected and republishes its card', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const harness = clickHarness();
  const { layer, calls } = await enabledLayer(receiver, clock, null, {
    engine: harness.engine,
  });
  t.after(() => {
    layer.destroy();
    harness.release();
  });
  receiver.set({ aircraft: [record()] });
  await layer.update();
  // The engine names the marker's sprite by its pick id.
  harness.scene.pickResult = { id: 'local-adsb:abc123' };
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123']);
  // Its card may have been displaced (another readout, a camera move): a
  // second click on the same marker must show it again, never deselect it.
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123', 'local-adsb:abc123']);
  assert.deepEqual(calls.cleared, []);
});

test('a click on a local aircraft under an unowned or trail pick still selects it', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const harness = clickHarness();
  const { layer, calls } = await enabledLayer(receiver, clock, null, {
    engine: harness.engine,
  });
  // The app's pick owners: the trails, and a Flights contact.
  registerPickOwner(
    'trails',
    (id) => String(id).startsWith('gev-trail:'),
    harness.engine,
  );
  registerPickOwner('flights', (id) => id === 'abc123', harness.engine);
  t.after(() => {
    unregisterPickOwner('trails', harness.engine);
    unregisterPickOwner('flights', harness.engine);
    layer.destroy();
    harness.release();
  });
  receiver.set({
    aircraft: [record(), record({ icao: 'def456', lat: 0.01 })],
  });
  await layer.update();
  const [first, second] = ['abc123', 'def456'].map(
    (icao) => `local-adsb:${icao}`,
  );
  // A photoreal tile (no pick id) drawn over the 3D model at this pixel.
  harness.scene.pickResult = { primitive: { tileset: true } };
  harness.scene.drillResult = [
    harness.scene.pickResult,
    { id: 'local-adsb:abc123' },
  ];
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123']);

  // The selected aircraft's trail crosses another local aircraft's marker.
  harness.scene.pickResult = { id: 'gev-trail:local-adsb-head-1' };
  harness.scene.drillResult = [harness.scene.pickResult, { id: second }];
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123', 'local-adsb:def456']);

  // Another layer's own contact on top is that layer's click.
  harness.scene.pickResult = { id: 'abc123' };
  harness.scene.drillResult = [harness.scene.pickResult, { id: first }];
  harness.click();
  assert.equal(calls.selected.length, 2, 'the Flights contact is not taken');
});

test('globe handoff retains the receiver, feed, trail fixes and selection', async (t) => {
  const receiver = fakeReceiver({ aircraft: [record()] });
  const feeds = fakeFeeds();
  let closes = 0;
  receiver.destroy = () => {
    closes++;
  };
  const clock = { now: 100_000 };
  const { layer, calls } = await enabledLayer(receiver, clock, feeds);
  t.after(() => layer.destroy());
  assert.ok(layer.selectAircraft('abc123'));
  layer.detachRenderer();
  clock.now += 1000;
  receiver.set({
    aircraft: [
      record({
        lon: 0.001,
        lastPositionAt: clock.now,
        lastMessageAt: clock.now,
      }),
    ],
  });
  await layer.update();
  assert.equal(layer.getAnalystRecords()[0].icao24, 'abc123');
  layer.attachRenderer({ engine: fakeEngine() });
  assert.deepEqual(receiver.modeCalls, ['adsb']);
  assert.deepEqual(feeds.calls, ['start']);
  assert.equal(closes, 0);
  assert.deepEqual(calls.selected, ['local-adsb:abc123', 'local-adsb:abc123']);
});
