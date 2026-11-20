import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { VEHICLE_TINT_CSS } from '../../data/aircraftClass.js';
import { layerFeedState } from '../../data/feedState.js';
import { aircraftIcon } from '../../data/aircraftIcons.js';
import { ROTOR_STILL_FRAME, rotorFrame } from '../../data/rotorFrames.js';
import {
  createLocalAdsbLayer,
  HEARD_BY_RECEIVER,
  localAdsbCardModel,
  localAdsbReceiverLine,
  localAdsbStatus,
} from './index.js';
import { createLocalAdsbModels } from './models.js';
import { entityRecord, readEntityRecord } from '../../data/entityRecords.js';
import {
  isUnderOtherCard,
  resolvePickId,
  setClickCardHitTest,
} from '../../data/pickRegistry.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { inputFor } from '../../input/dispatcher.js';
import { MISSION_LABEL, fakeInput } from '../../input/testDoubles.mjs';
import { hexColor } from '../../render/color.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const MAGENTA = hexColor('#ff4fd8');

/** The layer's live draw set whose id ends with `suffix`. */
function layerSet(draw, suffix) {
  return [...draw.sets.values()].find(
    (record) =>
      !record.disposed &&
      record.spec.id.startsWith('local-adsb:') &&
      record.spec.id.endsWith(suffix),
  );
}

/** The icon drawn for an aircraft, or undefined. */
const iconOf = (draw, id) => layerSet(draw, ':markers')?.items.get(id);
/** The 978 MHz ring drawn for an aircraft, or undefined. */
const ringOf = (draw, id) => layerSet(draw, ':rings')?.items.get(id);
/** Degrees of latitude where an aircraft's icon now is. */
const latitudeOf = (draw, id) => toLonLatH(iconOf(draw, id).pos).lat;
import { loadFleetModelSet } from '../../data/fleetModels.js';
import { aircraftLayerModelSpec } from '../flights/modelSpec.js';
import { fetchPublicFile } from '../../testSupport/fleetGlb.mjs';

// The layer draws models only once the fleet model set has loaded; load it from disk.
const realInfo = console.info;
console.info = () => {};
await loadFleetModelSet({ fetchImpl: fetchPublicFile });
console.info = realInfo;

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
  const calls = {
    registered: [],
    selected: [],
    cleared: [],
    removed: [],
    carriers: new Map(),
  };
  let selected = null;
  return {
    calls,
    services: {
      render: { governorRequestRender() {} },
      context: {
        registerEntityContext(entity, metadata) {
          entityRecord(entity).contextId = metadata.id;
          calls.registered.push(metadata);
          calls.carriers.set(metadata.id, entity);
        },
        selectEntityContext(entity) {
          selected = { id: readEntityRecord(entity)?.contextId, entity };
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
      picking: {
        registerPickOwner() {},
        unregisterPickOwner() {},
        resolvePickId,
      },
      detection: { markSourcesChanged() {} },
      overlays: { refreshReadout() {} },
    },
  };
}

/**
 * A viewer with a fake draw port, a camera port whose screen axes are east
 * and north at (0°, 0°), and a query port whose drill picks are the
 * viewer's `drillHits`; `pose` sets the camera.
 */
function fakeViewer(viewer = { scene: {} }, pose = {}) {
  const camera = fakeCameraPort({
    pose: { right: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 }, ...pose },
  });
  const query = {
    drillPick: (x, y, { limit } = {}) =>
      (viewer.drillHits ?? []).slice(0, limit),
  };
  const { draw } = bindFakeDraw(viewer, { camera: camera.port, query });
  const input = fakeInput(viewer);
  return { draw, viewer, input, camera };
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

/** A viewer whose camera looks down on (0°, 0°) from 2 km: within the 3 km
 *  model radius of an aircraft there on the ground or at 10,000 ft. */
function modelViewer() {
  return fakeViewer(
    { scene: {} },
    {
      height: 2_000,
      position: { x: 6_378_137 + 2_000, y: 0, z: 0 },
      direction: { x: -1, y: 0, z: 0 },
    },
  );
}

async function enabledLayer(receiver, clock, feeds = null, options = {}) {
  const { services, calls } = fakeServices();
  const { draw, viewer } = options.viewer || fakeViewer();
  const layer = createLocalAdsbLayer({
    receiver,
    feeds,
    services: { ...services, ...options.services },
    now: () => clock.now,
  });
  layer.init(viewer);
  await layer.enable();
  return { layer, calls, draw };
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

test('local aircraft use their class silhouette at one size in magenta', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, draw, calls } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({
    aircraft: [record(), record({ icao: 'a0b702', category: 'A7' })],
  });
  await layer.update();

  const icon = iconOf(draw, 'local-adsb:abc123');
  assert.ok(icon);
  assert.equal(ringOf(draw, 'local-adsb:abc123'), undefined);
  assert.equal(icon.image, aircraftIcon('airliner'));
  assert.deepEqual(icon.size, [20, 20]);
  assert.deepEqual(icon.color, MAGENTA);
  assert.equal(icon.rotationMode, 'screen', 'upright on screen, turned');
  assert.equal(icon.rotation, 0);
  assert.deepEqual(icon.displayRange, [0, 2_000_000]);
  assert.equal(icon.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(layerSet(draw, ':markers').spec.horizonCull, true);
  const carrier = calls.carriers.get('local-adsb:abc123');
  assert.equal(icon.meta, carrier, 'a pick hands point-and-ask the carrier');
  assert.equal(readEntityRecord(carrier)?.labelModel.title, 'LOCAL1');
  assert.equal(typeof readEntityRecord(carrier)?.displayPosition, 'function');

  const heli = () => iconOf(draw, 'local-adsb:a0b702');
  // Airborne, its rotor turns: the frame of its own phase at the layer's time.
  assert.equal(
    heli().image,
    aircraftIcon(
      'helicopter',
      undefined,
      rotorFrame('local-adsb:a0b702', clock.now),
    ),
  );
  assert.equal(heli().scale, 1, 'every class draws at one size');
  assert.equal(icon.scale, heli().scale);
  assert.deepEqual(
    heli().color,
    MAGENTA,
    'the helicopter keeps the local magenta',
  );
  assert.equal(
    readEntityRecord(calls.carriers.get('local-adsb:a0b702'))?.labelModel
      .details[1],
    'Helicopter · A7',
  );

  // On the ground the silhouette shrinks like a grounded public flight.
  receiver.set({
    aircraft: [
      record({
        icao: 'a0b702',
        category: 'A7',
        onGround: true,
        groundSpeedKt: 0,
        lastPositionAt: 100_500,
      }),
    ],
  });
  await layer.update();
  assert.equal(heli().scale, 0.8);
  // Parked on the ground its rotor holds still.
  assert.equal(
    heli().image,
    aircraftIcon('helicopter', undefined, ROTOR_STILL_FRAME),
  );

  const [detectable] = layer.getDetectableObjects();
  assert.equal(detectable.sourceId, 'a0b702');
  assert.equal(detectable.type, 'AIR');
});

test('local airport vehicles draw the amber vehicle sprite, ground stations the upright mast', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, draw } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({
    aircraft: [
      record({ icao: 'a0c001', category: 'C1', trackDeg: 90 }),
      record({ icao: 'a0c002', category: 'C2', trackDeg: 90 }),
      record({ icao: 'a0c003', category: 'C3', trackDeg: 90 }),
    ],
  });
  await layer.update();
  for (const id of ['a0c001', 'a0c002']) {
    const icon = iconOf(draw, `local-adsb:${id}`);
    assert.equal(icon.image, aircraftIcon('vehicle'), id);
    assert.deepEqual(icon.color, hexColor(VEHICLE_TINT_CSS), id);
  }
  const mast = iconOf(draw, 'local-adsb:a0c003');
  assert.equal(mast.image, aircraftIcon('station'));
  assert.deepEqual(mast.color, MAGENTA);
  assert.equal(mast.rotation, 0, 'upright whatever its track');
});

test('the heading slews toward a new track instead of snapping', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, draw } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record()] });
  await layer.update();
  const rotation = () => iconOf(draw, 'local-adsb:abc123').rotation;
  assert.equal(rotation(), 0);

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
  const first = rotation();
  assert.ok(
    first > -Cesium.Math.PI_OVER_TWO && first <= 0,
    'one frame does not swing the nose 90°',
  );
  for (let frame = 0; frame < 12; frame += 1) {
    clock.now += 250;
    await layer.update();
  }
  assert.ok(
    Math.abs(rotation() + Cesium.Math.PI_OVER_TWO) < 1e-6,
    'the nose settles on the new track',
  );
});

test('markers move in real time between fixes and never jump on a new fix', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, draw } = await enabledLayer(receiver, clock);
  t.after(() => layer.destroy());
  const latitude = () => latitudeOf(draw, 'local-adsb:abc123');
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
  const { layer, draw } = await enabledLayer(receiver, clock);
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
  const lat = latitudeOf(draw, 'local-adsb:abc123');
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

test('the trail head runs from the last fix to the marker every frame, dimmed behind the surface', async (t) => {
  const trails = await import('../../data/trailRenderer.js');
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const listeners = new Map();
  const frame = {
    on(event, callback) {
      listeners.set(event, callback);
      return () => listeners.delete(event);
    },
  };
  const viewer = { scene: {} };
  const camera = fakeCameraPort({
    pose: { right: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  });
  const { draw } = bindFakeDraw(viewer, { camera: camera.port, frame });
  const input = fakeInput(viewer);
  const { layer } = await enabledLayer(receiver, clock, null, {
    viewer: { draw, viewer, input },
    services: { trails },
  });
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record()] });
  await layer.update();
  assert.equal(layer.selectAircraft('abc123'), true);
  // The head is the shared trail's head line.
  const trailSet = () => draw.find('trail:');
  const heads = () =>
    [...(trailSet()?.items.values() ?? [])].filter(
      (line) => line.id.endsWith(':head') && line.show !== false,
    );
  // Selected at its fix, the head has no length yet.
  assert.equal(heads().length, 0);
  clock.now = 100_500;
  listeners.get('preRender')();
  const [head] = heads();
  assert.match(head.id, /^gev-trail:\d+:head$/);
  assert.equal(head.mode, '3d');
  assert.equal(head.widthPx, 2.5);
  assert.deepEqual(head.style, {
    kind: 'solid',
    color: hexColor('#ff4fd8', 0.9),
  });
  assert.deepEqual(
    head.depthFail,
    { kind: 'solid', color: hexColor('#ff4fd8', 0.45) },
    'dimmed, not hidden, behind the surface',
  );
  assert.equal(head.positions.length, 2);
  assert.deepEqual(
    head.positions[1],
    iconOf(draw, 'local-adsb:abc123').pos,
    'it ends at the marker',
  );

  // A frame alone moves the marker, its icon and the head's end.
  const before = latitudeOf(draw, 'local-adsb:abc123');
  clock.now = 101_000;
  listeners.get('preRender')();
  const after = latitudeOf(draw, 'local-adsb:abc123');
  assert.ok(after > before, `the marker flew north (${before} → ${after})`);
  assert.ok(
    Math.abs(toLonLatH(heads()[0].positions[1]).lat - after) < 1e-9,
    'the head follows the marker',
  );
  // The next frame too, as the entity's head was rebuilt every frame.
  clock.now = 101_016;
  listeners.get('preRender')();
  assert.deepEqual(
    heads()[0].positions[1],
    iconOf(draw, 'local-adsb:abc123').pos,
    'the head ends on the icon a frame later',
  );

  // A frame where nothing moved leaves the head alone.
  const writes = trailSet().writes;
  listeners.get('preRender')();
  assert.equal(trailSet().writes, writes);

  await layer.disable();
  assert.equal(listeners.has('preRender'), false, 'frames stop when off');
  assert.equal(heads().length, 0, 'the head leaves with the selection');
});

test('adsbdb type, operator and route reach the card for the selected aircraft only', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const queries = [];
  const { layer, calls } = await enabledLayer(receiver, clock, null, {
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
  const entity = calls.carriers.get('local-adsb:a0b702');
  assert.deepEqual(readEntityRecord(entity)?.labelModel.details.slice(0, 4), [
    'ICAO A0B702 · EVC145',
    'Helicopter · A7',
    'Air Evac · Bell 407',
    'AUS → SAT',
  ]);
  assert.equal(
    readEntityRecord(entity)?.labelModel.details.at(-1),
    'Heard by your receiver · 1090 MHz · browser SDR',
  );
  layer.selectAircraft('a0b702');
  await layer.update();
  assert.equal(queries.length, 2, 'each key is asked for once');
});

test('the DISPLAY 3D toggle gives local aircraft their fleet models in their mesh colours', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const display = { models3d: true, models3dMode: 'proximity' };
  const { layer, draw } = await enabledLayer(receiver, clock, null, {
    services: { display: { getParams: () => display } },
    viewer: modelViewer(),
  });
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record({ icao: 'a0b702', category: 'A7' })] });
  await layer.update();
  const models = layerSet(draw, ':models');
  const model = () => models.items.get('local-adsb:a0b702');
  assert.ok(model(), 'admitted');
  const spec = aircraftLayerModelSpec({ category: 'A7' });
  assert.equal(
    model().url,
    '/models/fleet/helicopters/generic_heli.glb',
    'the Flights rotorcraft model',
  );
  assert.ok(model().gltf instanceof Uint8Array, 'built from the loaded set');
  assert.equal(model().scale, spec.scale, 'drawn life size');
  assert.deepEqual(
    model().tint,
    [1, 1, 1, 1],
    'the mesh draws its own colours',
  );
  assert.deepEqual(model().colorBlend, { mode: 'highlight' });
  assert.equal(model().environmentMap, false);
  const heli = () => iconOf(draw, 'local-adsb:a0b702');
  assert.equal(heli().show, true, 'the icon until the model is ready');
  draw.ready(models.spec.id, 'local-adsb:a0b702');
  await layer.update();
  assert.equal(model().show, true);
  assert.equal(heli().show, false, 'the model is the visual');
  assert.ok(
    Math.hypot(
      model().pos.x - heli().pos.x,
      model().pos.y - heli().pos.y,
      model().pos.z - heli().pos.z,
    ) < 1,
    'where its icon is',
  );
  const writes = models.writes;
  await layer.update();
  assert.ok(models.writes > writes, 'moved in place each frame');

  display.models3d = false;
  await layer.update();
  assert.equal(models.items.size, 0, 'models dropped');
  assert.equal(heli().show, true, 'the icon is back');
});

test('markers drop when the position is 60 s old and records when silent 60 s', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, draw } = await enabledLayer(receiver, clock);
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
  const entities = () => [...layerSet(draw, ':markers').items.keys()];
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
  const { layer, draw, calls } = await enabledLayer(receiver, clock, feeds);
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
  const shared = calls.carriers.get('local-adsb:abc123');
  const uat = calls.carriers.get('local-adsb:a1b2c3');
  assert.equal(layerSet(draw, ':markers').items.size, 2);
  assert.ok(
    Math.abs(latitudeOf(draw, 'local-adsb:abc123') - 1) < 0.002,
    'the newer feed position wins',
  );
  assert.equal(
    ringOf(draw, 'local-adsb:abc123'),
    undefined,
    'heard on 1090 too: no UAT ring',
  );
  assert.equal(
    readEntityRecord(shared)?.labelModel.details.at(-1),
    'Heard by your receiver · 1090 MHz + 978 MHz UAT · browser SDR + decoder feed',
  );
  const ring = ringOf(draw, 'local-adsb:a1b2c3');
  assert.ok(ring, 'a UAT-only aircraft carries the ring');
  assert.equal(ring.outlineWidth, 1.5);
  assert.deepEqual(ring.color, [0, 0, 0, 0]);
  assert.deepEqual(ring.outlineColor, hexColor('#ffb3ef'));
  assert.deepEqual(
    ring.displayRange,
    [0, 2_000_000],
    'shown within 2,000 km, as its aircraft is',
  );
  assert.deepEqual(ring.pos, iconOf(draw, 'local-adsb:a1b2c3').pos);
  assert.equal(layerSet(draw, ':rings').spec.horizonCull, true);
  assert.deepEqual(
    iconOf(draw, 'local-adsb:a1b2c3').color,
    MAGENTA,
    'same magenta marker family',
  );
  assert.equal(
    readEntityRecord(uat)?.labelModel.details.at(-1),
    'Heard by your receiver · 978 MHz UAT · decoder feed',
  );
  const stats = layer.getStats();
  assert.equal(stats.source, 'WebUSB + decoder feeds');
  assert.equal(stats.loadingLabel, '1 feed live · 2 heard');
  assert.equal(stats.count, 2);

  // Heard on 1090 as well later: the ring goes.
  feeds.set({
    records: [
      record({
        icao: 'a1b2c3',
        callsign: 'N978UA',
        band: '1090',
        source: 'feed',
      }),
    ],
  });
  await layer.update();
  assert.equal(ringOf(draw, 'local-adsb:a1b2c3'), undefined);

  await layer.disable();
  assert.deepEqual(feeds.calls, ['start', 'stop']);
  assert.equal(layerSet(draw, ':markers').show, false, 'hidden with the layer');
});

test('the layer draws into sets of its own, shown while it is enabled and let go when destroyed', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const feeds = fakeFeeds();
  const clock = { now: 100_000 };
  const first = fakeViewer();
  const { layer, draw } = await enabledLayer(receiver, clock, feeds, {
    viewer: first,
  });
  const other = await enabledLayer(fakeReceiver(), clock);
  t.after(() => other.layer.destroy());
  const ids = (port) =>
    [...port.sets.values()]
      .filter((record) => !record.disposed)
      .map((record) => record.spec.id);
  const mine = ids(draw);
  assert.equal(mine.length, 3, 'markers, rings and models');
  assert.ok(
    ids(other.draw).every((id) => !mine.includes(id)),
    'a second layer has ids of its own',
  );
  for (const id of mine) assert.equal(draw.set(id).show, true, id);

  feeds.set({
    configured: true,
    records: [record({ icao: 'a1b2c3', band: '978', source: 'feed' })],
  });
  await layer.update();
  assert.ok(ringOf(draw, 'local-adsb:a1b2c3'));
  // Silent long enough to expire: its ring goes with it.
  clock.now = 200_000;
  await layer.update();
  assert.equal(iconOf(draw, 'local-adsb:a1b2c3'), undefined);
  assert.equal(ringOf(draw, 'local-adsb:a1b2c3'), undefined);

  await layer.disable();
  for (const id of mine) assert.equal(draw.set(id).show, false, id);
  await layer.enable();
  for (const id of mine) assert.equal(draw.set(id).show, true, id);
  layer.destroy();
  assert.deepEqual(ids(draw), [], 'every set disposed');
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

test('the last aircraft expiring removes its 3D model', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const { layer, draw } = await enabledLayer(receiver, clock, null, {
    services: {
      display: {
        getParams: () => ({ models3d: true, models3dMode: 'proximity' }),
      },
    },
    viewer: modelViewer(),
  });
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record({ category: 'A7' })] });
  await layer.update();
  const models = layerSet(draw, ':models');
  assert.ok(models.items.has('local-adsb:abc123'));

  // Its position ages out: no markers remain, so no per-frame model pass.
  clock.now = 160_000;
  await layer.update();
  assert.equal(models.items.size, 0, 'no model left behind');

  layer.destroy();
  assert.equal(models.disposed, true, 'the set goes with the layer');
});

/** A pick on a draw-port icon of the layer's, as the renderer reports it. */
function iconPick(draw, id) {
  return { primitive: {}, id: { set: layerSet(draw, ':markers').spec.id, id } };
}

/** A viewer with a canvas and scripted picks, plus the layer's click action.
 *  A click drills through the viewer's `drillHits`. */
function clickHarness() {
  const scene = {
    canvas: {},
    pickResult: null,
    pick() {
      return scene.pickResult;
    },
    drillPick: () =>
      (base.viewer.drillHits ?? []).map((hit) => ({ primitive: {}, id: hit })),
  };
  const base = fakeViewer({ scene });
  return {
    scene,
    viewer: base,
    click() {
      base.input.click(new Cesium.Cartesian2(10, 10));
    },
  };
}

test('clicking the selected aircraft keeps it selected and republishes its card', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const harness = clickHarness();
  const { layer, calls, draw } = await enabledLayer(receiver, clock, null, {
    viewer: harness.viewer,
  });
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record()] });
  await layer.update();
  harness.scene.pickResult = iconPick(draw, 'local-adsb:abc123');
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123']);
  // Its card may have been displaced (another readout, a camera move): a
  // second click on the same marker must show it again, never deselect it.
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123', 'local-adsb:abc123']);
  assert.deepEqual(calls.cleared, []);
});

// The card or label painted on top takes the click: a local aircraft under
// another layer's card is neither selected nor released.
test("another layer's card over a local aircraft keeps the click", async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const harness = clickHarness();
  let top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  setClickCardHitTest(() => top);
  t.after(() => setClickCardHitTest(null));
  const { layer, calls, draw } = await enabledLayer(receiver, clock, null, {
    viewer: harness.viewer,
    services: {
      picking: {
        registerPickOwner() {},
        unregisterPickOwner() {},
        resolvePickId,
        isUnderOtherCard,
      },
    },
  });
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record()] });
  await layer.update();
  harness.scene.pickResult = iconPick(draw, 'local-adsb:abc123');
  harness.click();
  assert.deepEqual(calls.selected, [], 'covered: not selected');
  top = null;
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123']);
  top = { sourceId: 'earthquake-card', entryId: 'earthquake-card:ak1' };
  harness.scene.pickResult = null;
  harness.click();
  assert.deepEqual(calls.cleared, [], 'covered: the selection stays');
});

test('a click on a local aircraft under an unowned or trail pick still selects it', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const harness = clickHarness();
  const owners = new Map();
  const { layer, calls, draw } = await enabledLayer(receiver, clock, null, {
    viewer: harness.viewer,
    services: {
      picking: {
        registerPickOwner: (id, predicate) => owners.set(id, predicate),
        unregisterPickOwner: (id) => owners.delete(id),
        resolvePickId,
        isOwnedByOtherLayer: (layerId, pickedId) =>
          [...owners].some(
            ([owner, predicate]) => owner !== layerId && predicate(pickedId),
          ),
      },
    },
  });
  owners.set('trails', (id) => String(id).startsWith('gev-trail:'));
  owners.set('flights', (id) => id === 'abc123');
  t.after(() => layer.destroy());
  receiver.set({
    aircraft: [record(), record({ icao: 'def456', lat: 0.01 })],
  });
  await layer.update();
  const hit = (suffix, id) => ({
    set: suffix.startsWith(':') ? layerSet(draw, suffix).spec.id : suffix,
    id,
    surface: false,
  });
  const second = hit(':markers', 'local-adsb:def456');
  // A photoreal tile (no pick id) drawn over the 3D model at this pixel.
  harness.scene.pickResult = { primitive: { tileset: true } };
  harness.viewer.viewer.drillHits = [hit(':models', 'local-adsb:abc123')];
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123']);

  // The selected aircraft's trail crosses another local aircraft's marker.
  const trail = hit('trail:1', 'gev-trail:1:head');
  harness.scene.pickResult = { primitive: {}, id: trail };
  harness.viewer.viewer.drillHits = [trail, second];
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123', 'local-adsb:def456']);

  // Another layer's own contact on top is that layer's click.
  harness.scene.pickResult = { id: 'abc123', primitive: {} };
  harness.viewer.viewer.drillHits = [hit(':markers', 'local-adsb:abc123')];
  harness.click();
  assert.equal(calls.selected.length, 2, 'the Flights contact is not taken');
});

test('a click on a mission label over a local aircraft never selects the aircraft, and keeps the selection', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const harness = clickHarness();
  // A Space Missions label painted over the map: while it is over, it takes
  // each click and is the card on top.
  const label = { over: true };
  setClickCardHitTest(() => (label.over ? MISSION_LABEL : null));
  t.after(() => setClickCardHitTest(null));
  const { layer, calls, draw } = await enabledLayer(receiver, clock, null, {
    viewer: harness.viewer,
    services: {
      picking: {
        registerPickOwner() {},
        unregisterPickOwner() {},
        resolvePickId,
        isUnderOtherCard,
      },
    },
  });
  t.after(() => layer.destroy());
  receiver.set({ aircraft: [record()] });
  await layer.update();
  inputFor(harness.viewer.viewer).onOverlayClick(() => label.over);
  const model = {
    set: layerSet(draw, ':models').spec.id,
    id: 'local-adsb:abc123',
    surface: false,
  };
  // The aircraft is under the label, both exactly and in the drill.
  harness.scene.pickResult = iconPick(draw, 'local-adsb:abc123');
  harness.viewer.viewer.drillHits = [model];
  harness.click();
  assert.deepEqual(calls.selected, [], 'the aircraft beneath is not taken');

  // Off the label the same click selects it; the label on top is its own
  // click, so the selection stays.
  label.over = false;
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123']);
  label.over = true;
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:abc123']);
  assert.equal(calls.cleared.length, 0, 'the selection stays');
});

test('a grounded aircraft changing type keeps its drawn model on its own belly offset until the new one is ready', () => {
  const { draw, viewer, camera } = modelViewer();
  const models = createLocalAdsbModels({
    viewer,
    draw,
    camera: camera.port,
    setId: 'test:models',
    color: '#ff00ff',
    resolveAsset: (url) => url,
    groundSnap: { heightFor: () => 100, forget() {}, clear() {} },
  });
  const marker = {
    position: fromDegrees(0, 0, 0),
    courseDeg: 0,
    typeCode: 'C172',
    onGround: true,
  };
  const markers = new Map([['a', marker]]);
  const display = { models3d: true, models3dMode: 'proximity' };
  const light = 100 + aircraftLayerModelSpec({ typeCode: 'C172' }).bellyM;
  const widebody = 100 + aircraftLayerModelSpec({ typeCode: 'B789' }).bellyM;
  const height = () =>
    toLonLatH(draw.sets.get('test:models').items.get('a').pos).height;
  models.frame(markers, display, 100_000);
  draw.ready('test:models', 'a');
  models.frame(markers, display, 100_001);
  assert.ok(Math.abs(height() - light) < 0.01, 'light: its belly offset');
  marker.typeCode = 'B789';
  models.frame(markers, display, 200_000);
  assert.equal(
    draw.sets.get('test:models').items.get('a').url,
    '/models/fleet/aircraft/b789.glb',
  );
  assert.ok(Math.abs(height() - light) < 0.01, 'the light model still draws');
  draw.ready('test:models', 'a');
  models.frame(markers, display, 200_001);
  assert.ok(Math.abs(height() - widebody) < 0.01, 'the widebody, on its own');
  models.destroy();
});

test('a type change takes its belly offset with the new model, however soon it is ready; a scale-only change at once', () => {
  const { draw, viewer, camera } = modelViewer();
  const models = createLocalAdsbModels({
    viewer,
    draw,
    camera: camera.port,
    setId: 'test:models',
    color: '#ff00ff',
    resolveAsset: (url) => url,
    groundSnap: { heightFor: () => 100, forget() {}, clear() {} },
  });
  const marker = {
    position: fromDegrees(0, 0, 0),
    courseDeg: 0,
    typeCode: 'A320',
    onGround: true,
  };
  const markers = new Map([['a', marker]]);
  const display = { models3d: true, models3dMode: 'proximity' };
  const bellyOf = (typeCode) =>
    100 + aircraftLayerModelSpec({ typeCode }).bellyM;
  const item = () => draw.sets.get('test:models').items.get('a');
  const height = () => toLonLatH(item().pos).height;
  models.frame(markers, display, 100_000);
  draw.ready('test:models', 'a');
  models.frame(markers, display, 100_001);
  assert.ok(Math.abs(height() - bellyOf('A320')) < 0.01, 'A320');
  // The same model at another length: no load, no ready.
  marker.typeCode = 'A321';
  models.frame(markers, display, 100_002);
  assert.equal(item().url, '/models/fleet/aircraft/a320.glb');
  assert.equal(
    item().scale,
    aircraftLayerModelSpec({ typeCode: 'A321' }).scale,
  );
  assert.ok(Math.abs(height() - bellyOf('A321')) < 0.01, 'at once');
  // Another model, ready before the next eligibility pass.
  marker.typeCode = 'B789';
  models.frame(markers, display, 100_003);
  assert.ok(Math.abs(height() - bellyOf('A321')) < 0.01, 'the old model draws');
  draw.ready('test:models', 'a');
  models.frame(markers, display, 100_004);
  assert.ok(
    Math.abs(height() - bellyOf('B789')) < 0.01,
    'the widebody, on its own',
  );
  models.destroy();
});

test('a click on a UAT ring selects its aircraft, as the ring was a point on its entity', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const feeds = fakeFeeds();
  const clock = { now: 100_000 };
  const harness = clickHarness();
  const { layer, calls, draw } = await enabledLayer(receiver, clock, feeds, {
    viewer: harness.viewer,
  });
  t.after(() => layer.destroy());
  feeds.set({
    configured: true,
    feeds: [{ band: '978', label: '978 MHz UAT', status: 'live' }],
    records: [record({ icao: 'a1b2c3', band: '978', source: 'feed' })],
  });
  await layer.update();
  const rings = layerSet(draw, ':rings');
  assert.notEqual(rings.spec.pickable, false, 'the rings are picked');
  assert.notEqual(ringOf(draw, 'local-adsb:a1b2c3').pickable, false);
  harness.scene.pickResult = {
    primitive: {},
    id: { set: rings.spec.id, id: 'local-adsb:a1b2c3' },
  };
  harness.click();
  assert.deepEqual(calls.selected, ['local-adsb:a1b2c3']);
});

test('a tap near a local aircraft but on nothing selects nothing, as the exact pick did', async (t) => {
  const receiver = fakeReceiver({ mode: 'adsb', connected: true });
  const clock = { now: 100_000 };
  const harness = clickHarness();
  const { layer, calls, draw } = await enabledLayer(receiver, clock, null, {
    viewer: harness.viewer,
  });
  t.after(() => layer.destroy());
  const priorMatch = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  t.after(() => {
    if (priorMatch === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = priorMatch;
  });
  receiver.set({ aircraft: [record()] });
  await layer.update();
  // The touch search finds contacts by their registered owner.
  const { registerPickOwner, unregisterPickOwner } =
    await import('../../data/pickRegistry.js');
  registerPickOwner('local-adsb-test', (id) =>
    String(id).startsWith('local-adsb:'),
  );
  t.after(() => unregisterPickOwner('local-adsb-test'));
  // Nothing exactly under the tap; the aircraft is within a touch's reach.
  harness.scene.pickResult = null;
  harness.scene.drillPick = (position, limit, width = 1) =>
    width > 1 ? [iconPick(draw, 'local-adsb:abc123')] : [];
  harness.viewer.viewer.drillHits = [];
  harness.click();
  assert.deepEqual(calls.selected, []);
});
