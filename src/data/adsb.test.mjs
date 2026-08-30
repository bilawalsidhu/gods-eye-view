import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { createAdsbLayer } from './adsb.js';

function fakeController(initialMode = 'fm') {
  const state = {
    connected: false,
    mode: initialMode,
    status: 'idle',
    message: 'Ready',
    aircraft: [],
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
    setAircraft(aircraft) {
      state.aircraft = aircraft;
      const next = snapshot();
      for (const listener of subscribers) listener(next);
    },
    async setMode(mode) {
      modeCalls.push(mode);
      state.mode = mode;
      return true;
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
      scene: {
        camera,
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

test('Local ADS-B owns the tuner mode even before WebUSB connects', async () => {
  const controller = fakeController('fm');
  const layer = createAdsbLayer({ controller });

  assert.equal(await layer.enable(), true);
  assert.deepEqual(controller.modeCalls, ['adsb']);
  assert.equal(controller.getState().mode, 'adsb');

  assert.equal(await layer.disable(), true);
  assert.deepEqual(controller.modeCalls, ['adsb', 'fm']);
  assert.equal(controller.getState().mode, 'fm');
});

test('Local ADS-B uses the live-flight silhouette and keeps its magenta identity', async () => {
  const controller = fakeController('adsb');
  const { sources, viewer } = fakeViewer();

  const layer = createAdsbLayer({ controller });
  layer.init(viewer);
  await layer.enable();
  controller.setAircraft([{
    icao: 'abc123',
    callsign: 'LOCAL1',
    latitude: 0,
    longitude: 0,
    altitudeFt: 10_000,
    speedKt: 180,
    headingDeg: 0,
    verticalRateFpm: 0,
    lastSeen: Date.now(),
  }]);

  const entity = sources[0].entities.getById('local-adsb:abc123');
  assert.ok(entity);
  assert.equal(entity.point, undefined);
  assert.equal(entity.label, undefined);
  assert.match(entity.billboard.image.getValue(), /^data:image\/svg\+xml;base64,/);
  assert.equal(entity.billboard.width.getValue(), 20);
  assert.equal(entity.billboard.height.getValue(), 20);
  assert.ok(Cesium.Color.equals(
    entity.billboard.color.getValue(),
    Cesium.Color.fromCssColorString('#ff4fd8'),
  ));
  assert.ok(Cesium.Cartesian3.equals(
    entity.billboard.alignedAxis.getValue(),
    Cesium.Cartesian3.ZERO,
  ));
  assert.equal(entity.billboard.disableDepthTestDistance.getValue(), Number.POSITIVE_INFINITY);
  assert.equal(entity.billboard.rotation.getValue(), 0);

  const [detectable] = layer.getDetectableObjects();
  assert.equal(detectable.sourceId, 'abc123');
  assert.equal(detectable.id, 'LOCAL1');
  assert.equal(detectable.type, 'AIR');
  assert.equal(detectable.skipLabel, false);
  assert.ok(detectable.position);

  controller.setAircraft([{
    ...controller.getState().aircraft[0],
    headingDeg: 90,
  }]);
  assert.ok(Math.abs(entity.billboard.rotation.getValue() + Cesium.Math.PI_OVER_TWO) < 1e-9);
});

test('Local ADS-B boxes require position and only label a decoded callsign', async () => {
  const controller = fakeController('adsb');
  const { viewer } = fakeViewer();
  const layer = createAdsbLayer({ controller });
  layer.init(viewer);
  await layer.enable();

  controller.setAircraft([
    {
      icao: 'boxed1',
      callsign: '   ',
      latitude: 30.2672,
      longitude: -97.7431,
      altitudeFt: 5_000,
      lastSeen: Date.now(),
    },
    {
      icao: 'nopos1',
      callsign: 'HIDDEN1',
      latitude: null,
      longitude: null,
      altitudeFt: 5_000,
      lastSeen: Date.now(),
    },
  ]);

  const objects = layer.getDetectableObjects();
  assert.equal(objects.length, 1, 'only positioned contacts receive a box');
  assert.equal(objects[0].sourceId, 'boxed1');
  assert.equal(objects[0].id, '', 'missing callsigns do not fall back to ICAO hex');
});
