import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { destinationPointDeg } from '../alpr/model.js';
import { layerFeedState } from '../../data/feedState.js';
import {
  createHorizonModel,
  createReceptionHorizonLayer,
  receptionHorizonInfo,
} from './index.js';
import { horizonGeometry, horizonHeightM } from './rendering.js';

const ANTENNA = Object.freeze({ lat: 30.2672, lon: -97.7431 });

function fixAt(bearingDeg, rangeKm, altitudeFt = 30_000, icao = 'abc123') {
  const point = destinationPointDeg(
    ANTENNA.lat,
    ANTENNA.lon,
    bearingDeg,
    rangeKm * 1000,
  );
  return {
    icao,
    lat: point.latitude,
    lon: point.longitude,
    altitudeFt,
    onGround: false,
    at: 1_000,
  };
}

function fakeLocalAdsb(receiverState = {}) {
  const fixListeners = new Set();
  const receiverListeners = new Set();
  let state = { receiverLocation: null, ...receiverState };
  return {
    emit(fix) {
      for (const listener of fixListeners) listener(fix);
    },
    get fixListeners() {
      return fixListeners.size;
    },
    subscribeHeardFixes(listener) {
      fixListeners.add(listener);
      return () => fixListeners.delete(listener);
    },
    receiver: {
      getState: () => state,
      subscribe(listener) {
        receiverListeners.add(listener);
        listener(state);
        return () => receiverListeners.delete(listener);
      },
      set(patch) {
        state = { ...state, ...patch };
        for (const listener of receiverListeners) listener(state);
      },
    },
  };
}

function fakePositions(receivers = []) {
  let state = { configured: true, receivers };
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
    start: () => calls.push('start'),
    stop: () => calls.push('stop'),
    destroy: () => calls.push('destroy'),
  };
}

function fakeInput() {
  let lease = null;
  let next = 1;
  return {
    claimPointer(owner) {
      if (lease) return null;
      lease = { owner, id: next++ };
      return lease;
    },
    releasePointer(token) {
      if (!lease || !token || token.id !== lease.id) return false;
      lease = null;
      return true;
    },
    isLeaseCurrent: (token) => Boolean(lease && token && token.id === lease.id),
    get owner() {
      return lease?.owner ?? null;
    },
  };
}

function harness({
  receivers = [],
  receiverState = {},
  input = fakeInput(),
} = {}) {
  const localAdsb = fakeLocalAdsb(receiverState);
  const positions = fakePositions(receivers);
  const draws = [];
  const visibility = [];
  let clickAction = null;
  const keyListeners = new Set();
  const ground = { lat: 29.42, lon: -98.49 };
  const viewer = {
    scene: {
      canvas: {},
      primitives: { add: (p) => p, remove() {} },
      pickPositionSupported: false,
    },
    camera: {
      pickEllipsoid: () =>
        Cesium.Cartesian3.fromDegrees(ground.lon, ground.lat, 0),
    },
  };
  const layer = createReceptionHorizonLayer({
    localAdsb,
    positions,
    services: {
      render: { governorRequestRender() {} },
      input,
      scenePick: { isPickedWorldPosition: (value) => Boolean(value) },
    },
    createRenderer: () => ({
      draw(snapshot, options = {}) {
        draws.push({ ...snapshot, verticalScale: options.verticalScale });
        return true;
      },
      setVisible: (visible) => visibility.push(visible),
      destroy() {},
    }),
    createInputHandler: () => ({
      setInputAction(action) {
        clickAction = action;
      },
      destroy() {
        clickAction = null;
      },
    }),
    document: {
      addEventListener: (_type, listener) => keyListeners.add(listener),
      removeEventListener: (_type, listener) => keyListeners.delete(listener),
    },
  });
  layer.init(viewer);
  return {
    layer,
    localAdsb,
    positions,
    draws,
    visibility,
    input,
    ground,
    click: () => clickAction?.({ position: new Cesium.Cartesian2(10, 10) }),
    hasClickHandler: () => Boolean(clickAction),
    pressKey: (key) => {
      for (const listener of keyListeners) listener({ key });
    },
  };
}

const FEED = {
  band: '1090',
  label: '1090 MHz',
  status: 'located',
  position: ANTENNA,
};

test('the layer requires Local ADS-B and identifies itself', () => {
  assert.throws(
    () => createReceptionHorizonLayer({ localAdsb: {}, services: {} }),
    /requires the Local ADS-B layer/,
  );
  const { layer } = harness();
  assert.equal(layer.id, 'reception-horizon');
  assert.equal(layer.name, 'Reception Horizon');
});

test('positions heard before the layer is on are drawn once it is', async (t) => {
  const { layer, localAdsb, positions, draws, visibility } = harness({
    receivers: [FEED],
  });
  t.after(() => layer.destroy());
  for (const bearing of [0, 2, 4, 6])
    localAdsb.emit(fixAt(bearing, 200 + bearing));
  assert.equal(draws.length, 0, 'nothing is drawn while the layer is off');
  await layer.enable();
  assert.deepEqual(positions.calls, ['start']);
  assert.deepEqual(visibility, [true]);
  const drawn = draws.at(-1);
  assert.equal(drawn.counted, 4);
  assert.deepEqual(
    { lat: drawn.antenna.lat, lon: drawn.antenna.lon },
    { lat: ANTENNA.lat, lon: ANTENNA.lon },
  );
  const stats = layer.getStats();
  assert.equal(stats.countLabel, '206\u00a0km');
  assert.equal(stats.count, 4);
  assert.match(stats.source, /antenna from 1090 MHz receiver\.json/);
  assert.equal(layerFeedState(stats), 'nominal');
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.legend.map(({ label }) => label),
    ['<5k ft', '5–15k', '15–25k', '25–35k 206 km', '35k+ ft'],
  );
  assert.match(
    controls.info,
    /4 positions from 1 aircraft · farthest 206 km \(111 NM\) at 6°, FL300/,
  );
});

test('without an antenna the row guides the operator and keeps positions', async (t) => {
  const { layer, localAdsb } = harness();
  t.after(() => layer.destroy());
  await layer.enable();
  localAdsb.emit(fixAt(90, 120));
  const stats = layer.getStats();
  assert.equal(stats.status, 'idle');
  assert.equal(stats.statusMessage, 'Needs your antenna position');
  assert.equal(layerFeedState(stats), 'nominal', 'guidance, not a fault');
  assert.match(
    layer.getRowControls().info,
    /LOCATE in the Radio card.*receiver\.json.*SET ANTENNA\. 1 position waiting\./,
  );
});

test('the browser LOCATE position is used until a decoder reports one', async (t) => {
  const browser = { latitude: 30.1, longitude: -97.6 };
  const { layer, positions, localAdsb } = harness({
    receiverState: { receiverLocation: browser },
  });
  t.after(() => layer.destroy());
  await layer.enable();
  assert.equal(layer.getHorizon().antenna.source, 'browser');
  positions.set({ receivers: [FEED] });
  assert.equal(layer.getHorizon().antenna.source, 'feed');
  positions.set({ receivers: [] });
  localAdsb.receiver.set({ receiverLocation: null });
  assert.equal(layer.getHorizon().antenna, null);
});

test('SET ANTENNA takes the pointer, places the antenna on click and gives it back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { layer, input, click, ground } = harness({ receivers: [FEED] });
  t.after(() => layer.destroy());
  await layer.enable();
  const chip = () =>
    layer.getRowControls().chips.find((c) => c.id === 'antenna-set');
  assert.equal(chip().label, 'SET ANTENNA');
  chip().onClick();
  assert.equal(input.owner, 'reception-horizon');
  assert.equal(chip().label, 'CLICK MAP');
  assert.match(layer.getRowControls().info, /Click your antenna on the globe/);
  click();
  const { antenna } = layer.getHorizon();
  assert.equal(antenna.source, 'manual');
  assert.ok(Math.abs(antenna.lat - ground.lat) < 1e-6);
  assert.ok(Math.abs(antenna.lon - ground.lon) < 1e-6);
  assert.equal(
    input.owner,
    'reception-horizon',
    'held until the click dispatches',
  );
  t.mock.timers.tick(0);
  assert.equal(input.owner, null);
  assert.equal(chip().label, 'SET ANTENNA');
  const auto = layer
    .getRowControls()
    .chips.find((c) => c.id === 'antenna-auto');
  assert.ok(auto, 'AUTO appears once the antenna was set by hand');
  auto.onClick();
  assert.equal(layer.getHorizon().antenna.source, 'feed');
  assert.ok(!layer.getRowControls().chips.some((c) => c.id === 'antenna-auto'));
});

test('a click while not armed, Escape and another tool holding the pointer place nothing', async (t) => {
  const input = fakeInput();
  const { layer, click, pressKey } = harness({ receivers: [FEED], input });
  t.after(() => layer.destroy());
  await layer.enable();
  click();
  assert.equal(layer.getHorizon().antenna.source, 'feed');

  layer.armAntennaPlacement();
  assert.equal(layer.getHorizon().armed, true);
  pressKey('Escape');
  assert.equal(layer.getHorizon().armed, false);
  assert.equal(input.owner, null);

  const other = input.claimPointer('draw');
  assert.equal(layer.armAntennaPlacement(), false);
  assert.match(layer.getRowControls().info, /Another tool is using map clicks/);
  click();
  assert.equal(layer.getHorizon().antenna.source, 'feed');
  input.releasePointer(other);
});

test('disabling hides the shell, stops polling and releases the pointer; positions still count', async (t) => {
  const { layer, localAdsb, positions, visibility, input, hasClickHandler } =
    harness({ receivers: [FEED] });
  t.after(() => layer.destroy());
  await layer.enable();
  layer.armAntennaPlacement();
  await layer.disable();
  assert.deepEqual(visibility, [true, false]);
  assert.deepEqual(positions.calls, ['start', 'stop']);
  assert.equal(input.owner, null);
  assert.equal(hasClickHandler(), false);
  localAdsb.emit(fixAt(45, 150));
  assert.equal(layer.getHorizon().horizon.counted, 1);
});

test('RESET forgets the session; destroy unsubscribes from Local ADS-B', async (t) => {
  const { layer, localAdsb, positions } = harness({ receivers: [FEED] });
  await layer.enable();
  localAdsb.emit(fixAt(45, 150));
  const reset = () =>
    layer.getRowControls().chips.find((c) => c.id === 'reset');
  assert.equal(reset().disabled, false);
  reset().onClick();
  assert.equal(layer.getHorizon().horizon.counted, 0);
  assert.equal(reset().disabled, true);
  layer.destroy();
  assert.equal(localAdsb.fixListeners, 0);
  assert.ok(positions.calls.includes('destroy'));
  t.diagnostic('destroyed');
});

test('a manual antenna must be a real position', async (t) => {
  const { layer } = harness({ receivers: [FEED] });
  t.after(() => layer.destroy());
  await layer.enable();
  assert.equal(layer.setAntennaPosition({ lat: 0, lon: 0 }), false);
  assert.equal(layer.setAntennaPosition({ lat: 'x', lon: 1 }), false);
  assert.equal(layer.getHorizon().antenna.source, 'feed');
  assert.equal(layer.setAntennaPosition({ lat: 31, lon: -97 }), true);
  assert.equal(layer.getHorizon().antenna.source, 'manual');
});

test('the info line names what was ignored and formats altitude like the HUD', () => {
  const model = createHorizonModel();
  model.setAntenna(ANTENNA);
  model.ingest(fixAt(270, 95, 12_500, 'a'));
  model.ingest(fixAt(10, 5_000, 30_000, 'b'));
  const info = receptionHorizonInfo(model.snapshot(), {
    ...ANTENNA,
    source: 'browser',
    feedLabel: null,
  });
  assert.equal(
    info,
    'Antenna: browser location (LOCATE) · 1 position from 1 aircraft · farthest 95 km (51 NM) at 270°, 12,500 ft · 1 position beyond line of sight ignored',
  );
});

test('geometry draws a wall and rim per outline run, a mast and a drop line', () => {
  const model = createHorizonModel();
  model.setAntenna(ANTENNA);
  for (let bearing = 0; bearing < 360; bearing += 2)
    model.ingest(fixAt(bearing, 150 + (bearing % 20), 30_000));
  for (const bearing of [100, 105, 110])
    model.ingest(fixAt(bearing, 60, 3_000));
  const { walls, lines } = horizonGeometry(model.snapshot());
  assert.equal(walls.length, 2, 'one closed ring at 25–35k, one arc below 5k');
  assert.equal(
    lines.length,
    4,
    'two rims, the antenna mast, the farthest drop line',
  );
  for (const instance of walls)
    assert.ok(instance.geometry instanceof Cesium.WallGeometry);
});

test('HEIGHT ×10 stretches only the drawn heights, and says so', async (t) => {
  const { layer, localAdsb, draws } = harness({ receivers: [FEED] });
  t.after(() => layer.destroy());
  await layer.enable();
  localAdsb.emit(fixAt(45, 150));
  const chip = () =>
    layer.getRowControls().chips.find((entry) => entry.id === 'height');
  assert.equal(chip().label, 'HEIGHT ×10');
  assert.equal(chip().active, false);
  assert.equal(draws.at(-1).verticalScale, 1);
  chip().onClick();
  assert.equal(chip().active, true);
  assert.equal(draws.at(-1).verticalScale, 10);
  assert.equal(layer.getHorizon().verticalScale, 10);
  assert.match(layer.getRowControls().info, /heights ×10 for display$/);
  assert.ok(
    Math.abs(draws.at(-1).farthest.rangeKm - 150) < 0.5,
    'ranges are never scaled',
  );
  chip().onClick();
  assert.equal(draws.at(-1).verticalScale, 1);
  assert.doesNotMatch(layer.getRowControls().info, /heights ×/);
});

test('drawn heights are barometric feet in metres, scaled for display only', () => {
  assert.equal(horizonHeightM(10_000), 3_048);
  assert.equal(horizonHeightM(10_000, 10), 30_480);
  assert.equal(horizonHeightM(-500), 0, 'never below the ellipsoid');
});
