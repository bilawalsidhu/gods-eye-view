import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  GEO_MESSAGES,
  GEO_OPTIONS,
  GEO_STATES,
  accuracyText,
  createGeolocator,
  createObserver,
  geoReduce,
  hasRealTerrain,
  observerEyeHeight,
  parseLatLon,
  sampleGroundHeight,
} from './observer.js';

test('parseLatLon accepts decimal pairs and hemisphere letters', () => {
  assert.deepEqual(parseLatLon('29.7604, -95.3698'), {
    latDeg: 29.7604,
    lonDeg: -95.3698,
  });
  assert.deepEqual(parseLatLon('29.7604 -95.3698'), {
    latDeg: 29.7604,
    lonDeg: -95.3698,
  });
  assert.deepEqual(parseLatLon('29.7604 N 95.3698 W'), {
    latDeg: 29.7604,
    lonDeg: -95.3698,
  });
  assert.deepEqual(parseLatLon('29.7604N, 95.3698W'), {
    latDeg: 29.7604,
    lonDeg: -95.3698,
  });
  assert.deepEqual(parseLatLon('s 33.86 e 151.21'), {
    latDeg: -33.86,
    lonDeg: 151.21,
  });
  assert.deepEqual(parseLatLon('95.3698 W 29.7604 N'), {
    latDeg: 29.7604,
    lonDeg: -95.3698,
  });
  assert.deepEqual(parseLatLon('29.7604° N 95.3698° W'), {
    latDeg: 29.7604,
    lonDeg: -95.3698,
  });
});

test('parseLatLon rejects junk, place names and out-of-range values', () => {
  for (const bad of [
    '',
    'Houston',
    '29.7',
    '1 2 3',
    '95 N 200 E',
    '91, 10',
    '10, 181',
    '-29 N 95 W',
    '29 E 95 E',
    null,
  ])
    assert.equal(parseLatLon(bad), null, String(bad));
});

test('createObserver: eye height 1.7 m default, unknown terrain -> 0 + flag', () => {
  const known = createObserver({
    latDeg: 29.76,
    lonDeg: -95.37,
    groundHeightM: 15,
    heightKnown: true,
    source: 'gps',
    accuracyM: 30,
  });
  assert.equal(known.eyeHeightM, 1.7);
  assert.equal(known.heightKnown, true);
  assert.equal(observerEyeHeight(known), 16.7);
  assert.equal(known.source, 'gps');
  const unknown = createObserver({
    latDeg: 29.76,
    lonDeg: -95.37,
    groundHeightM: Number.NaN,
    heightKnown: true,
  });
  assert.equal(unknown.groundHeightM, 0);
  assert.equal(unknown.heightKnown, false);
  const notFlagged = createObserver({
    latDeg: 1,
    lonDeg: 2,
    groundHeightM: 500,
  });
  assert.equal(
    notFlagged.groundHeightM,
    0,
    'height not marked known is not trusted',
  );
  assert.equal(notFlagged.heightKnown, false);
  assert.equal(createObserver({ latDeg: 95, lonDeg: 0 }), null);
  assert.equal(createObserver({ latDeg: 'x', lonDeg: 0 }), null);
  assert.equal(
    createObserver({ latDeg: 0, lonDeg: 0, source: 'evil' }).source,
    'manual',
  );
  assert.equal(
    createObserver({ latDeg: 0, lonDeg: 0, eyeHeightM: -3 }).eyeHeightM,
    1.7,
  );
  assert.equal(
    createObserver({ latDeg: 0, lonDeg: 0, eyeHeightM: 30 }).eyeHeightM,
    30,
  );
});

test('accuracyText: metres, km, and the > 5 km terrain warning', () => {
  assert.equal(accuracyText(30), '+/- 30 m');
  assert.equal(accuracyText(1500), '+/- 1.5 km');
  assert.match(
    accuracyText(12_000),
    /^\+\/- 12 km: .*terrain horizon may not match/,
  );
  assert.equal(accuracyText(null), null);
});

test('geolocation reducer covers every state', () => {
  const idle = { status: 'idle', coords: null };
  assert.equal(
    geoReduce(idle, { type: 'request', secure: false, supported: true }).status,
    'insecure-context',
  );
  assert.equal(
    geoReduce(idle, { type: 'request', secure: true, supported: false }).status,
    'unavailable',
  );
  const requesting = geoReduce(idle, {
    type: 'request',
    secure: true,
    supported: true,
  });
  assert.equal(requesting.status, 'requesting');
  // a second press while waiting is ignored (no duplicate request)
  assert.equal(
    geoReduce(requesting, { type: 'request', secure: true, supported: true }),
    requesting,
  );
  const ready = geoReduce(requesting, {
    type: 'success',
    coords: { latitude: 29.76, longitude: -95.37, accuracy: 25 },
  });
  assert.deepEqual(ready, {
    status: 'ready',
    coords: { latDeg: 29.76, lonDeg: -95.37, accuracyM: 25 },
  });
  assert.equal(
    geoReduce(requesting, { type: 'error', code: 1 }).status,
    'denied',
  );
  assert.equal(
    geoReduce(requesting, { type: 'error', code: 2 }).status,
    'unavailable',
  );
  assert.equal(
    geoReduce(requesting, { type: 'error', code: 3 }).status,
    'timeout',
  );
  assert.equal(
    geoReduce(requesting, { type: 'success', coords: {} }).status,
    'unavailable',
  );
  // late answers after the request ended are ignored
  assert.equal(geoReduce(ready, { type: 'error', code: 1 }), ready);
  // from any finished state a new press asks again
  for (const status of [
    'ready',
    'denied',
    'unavailable',
    'timeout',
    'insecure-context',
  ])
    assert.equal(
      geoReduce(
        { status, coords: null },
        { type: 'request', secure: true, supported: true },
      ).status,
      'requesting',
    );
  assert.equal(geoReduce(undefined, { type: 'noise' }).status, 'idle');
  for (const state of GEO_STATES)
    assert.equal(typeof GEO_MESSAGES[state], 'string');
  assert.match(GEO_MESSAGES.denied, /Allow it in the browser address bar/);
  assert.match(GEO_MESSAGES['insecure-context'], /https:\/\//);
});

function fakeGeolocation() {
  const calls = [];
  return {
    calls,
    getCurrentPosition(ok, fail, options) {
      calls.push({ ok, fail, options });
    },
  };
}

test('geolocator: one press = one request with high accuracy, 20 s timeout', () => {
  const geo = fakeGeolocation();
  const seen = [];
  const locator = createGeolocator({
    geolocation: geo,
    isSecureContext: true,
    onChange: (s, m) => seen.push([s.status, m]),
  });
  locator.request();
  locator.request();
  locator.request();
  assert.equal(geo.calls.length, 1);
  assert.equal(locator.calls, 1);
  assert.deepEqual(geo.calls[0].options, { ...GEO_OPTIONS });
  assert.equal(geo.calls[0].options.enableHighAccuracy, true);
  assert.equal(geo.calls[0].options.timeout, 20_000);
  geo.calls[0].ok({ coords: { latitude: 1, longitude: 2, accuracy: 9 } });
  assert.equal(locator.state.status, 'ready');
  assert.deepEqual(
    seen.map(([s]) => s),
    ['requesting', 'ready'],
  );
  assert.equal(seen[0][1], 'Waiting for your browser to allow location');
  // the next press makes exactly one more request
  locator.request();
  assert.equal(geo.calls.length, 2);
  geo.calls[1].fail({ code: 1 });
  assert.equal(locator.state.status, 'denied');
});

test('geolocator: insecure context and missing API never call the browser', () => {
  const geo = fakeGeolocation();
  const insecure = createGeolocator({
    geolocation: geo,
    isSecureContext: false,
  });
  assert.equal(insecure.request().status, 'insecure-context');
  assert.equal(geo.calls.length, 0);
  const missing = createGeolocator({
    geolocation: undefined,
    isSecureContext: true,
  });
  assert.equal(missing.request().status, 'unavailable');
  const throwing = createGeolocator({
    geolocation: {
      getCurrentPosition: () => {
        throw new Error('boom');
      },
    },
    isSecureContext: true,
  });
  assert.equal(throwing.request().status, 'unavailable');
  const timing = createGeolocator({ geolocation: geo, isSecureContext: true });
  timing.request();
  geo.calls[0].fail({ code: 3 });
  assert.equal(timing.state.status, 'timeout');
  timing.reset();
  assert.equal(timing.state.status, 'idle');
});

test('hasRealTerrain: ellipsoid provider is not terrain', () => {
  assert.equal(
    hasRealTerrain(Cesium, new Cesium.EllipsoidTerrainProvider()),
    false,
  );
  assert.equal(hasRealTerrain(Cesium, undefined), false);
  assert.equal(hasRealTerrain(Cesium, { requestTileGeometry() {} }), true);
});

test('sampleGroundHeight: terrain first, then 3D tiles, else 0 flagged unknown', async () => {
  const terrain = { requestTileGeometry() {} };
  const C = {
    ...Cesium,
    sampleTerrainMostDetailed: async (provider, cartos) => {
      assert.equal(provider, terrain);
      cartos[0].height = 15.5;
      return cartos;
    },
  };
  assert.deepEqual(
    await sampleGroundHeight({
      Cesium: C,
      viewer: { terrainProvider: terrain, scene: {} },
      latDeg: 29.76,
      lonDeg: -95.37,
    }),
    { heightM: 15.5, known: true, via: 'terrain' },
  );
  const tilesViewer = {
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    scene: {
      sampleHeightMostDetailed: async (cartos) =>
        cartos.map((c) => ({ ...c, height: 22 })),
    },
  };
  assert.deepEqual(
    await sampleGroundHeight({
      Cesium,
      viewer: tilesViewer,
      latDeg: 29.76,
      lonDeg: -95.37,
    }),
    { heightM: 22, known: true, via: 'tiles' },
  );
  // unknown everywhere -> 0 + flag
  const nothing = {
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    scene: {
      sampleHeightMostDetailed: async (cartos) =>
        cartos.map((c) => ({ ...c, height: undefined })),
    },
  };
  assert.deepEqual(
    await sampleGroundHeight({ Cesium, viewer: nothing, latDeg: 1, lonDeg: 2 }),
    { heightM: 0, known: false, via: 'none' },
  );
  const failing = {
    ...C,
    sampleTerrainMostDetailed: async () => {
      throw new Error('tile 404');
    },
  };
  assert.deepEqual(
    await sampleGroundHeight({
      Cesium: failing,
      viewer: { terrainProvider: terrain, scene: {} },
      latDeg: 1,
      lonDeg: 2,
    }),
    { heightM: 0, known: false, via: 'none' },
  );
  const slow = { ...C, sampleTerrainMostDetailed: () => new Promise(() => {}) };
  assert.deepEqual(
    await sampleGroundHeight({
      Cesium: slow,
      viewer: { terrainProvider: terrain, scene: {} },
      latDeg: 1,
      lonDeg: 2,
      timeoutMs: 20,
    }),
    { heightM: 0, known: false, via: 'none' },
  );
  assert.deepEqual(
    await sampleGroundHeight({ Cesium, viewer: null, latDeg: 1, lonDeg: 2 }),
    { heightM: 0, known: false, via: 'none' },
  );
  // the resulting observer carries the flag
  const sampled = await sampleGroundHeight({
    Cesium,
    viewer: nothing,
    latDeg: 1,
    lonDeg: 2,
  });
  const observer = createObserver({
    latDeg: 1,
    lonDeg: 2,
    groundHeightM: sampled.heightM,
    heightKnown: sampled.known,
  });
  assert.equal(observer.groundHeightM, 0);
  assert.equal(observer.heightKnown, false);
});
