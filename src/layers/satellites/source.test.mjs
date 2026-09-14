import test from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec } from 'satellite.js';
import { createSatelliteSource } from './source.js';
import { createSatellitesLayer } from './index.js';

test('satellite sources confine catalog groups and reject a cancelled body', async () => {
  const controller = new AbortController();
  let requests = 0;
  const source = createSatelliteSource({
    fetchImpl: async (url) => {
      requests++;
      assert.equal(url, '/api/celestrak/stations');
      return {
        ok: true,
        status: 200,
        text: async () => {
          controller.abort();
          return 'late catalog';
        },
      };
    },
  });
  await assert.rejects(
    source.readGroup('../active'),
    /Unknown satellite group/,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    source.readGroup('stations', { signal: controller.signal }),
    { name: 'AbortError' },
  );
});

test('satellite factories keep control state separate and construct without requests', () => {
  const source = {
    readGroup() {
      assert.fail('construction fetched a catalog');
    },
  };
  const services = Object.fromEntries(
    [
      'picking',
      'focus',
      'readout',
      'overlays',
      'context',
      'render',
      'layerState',
    ].map((key) => [key, {}]),
  );
  services.layerState.isExplicitLayerStateOrigin = () => false;
  const first = createSatellitesLayer({ source, services });
  const second = createSatellitesLayer({ source, services });
  first.setParams({ showPoints: false });
  assert.equal(first.getParams().showPoints, false);
  assert.equal(second.getParams().showPoints, true);
  assert.notEqual(first.getStats(), second.getStats());
});

test('satellite pass prediction methods report no-tle on cold catalog and coerce IDs', () => {
  const source = { readGroup() {} };
  const services = Object.fromEntries(
    [
      'picking',
      'focus',
      'readout',
      'overlays',
      'context',
      'render',
      'layerState',
    ].map((key) => [key, {}]),
  );
  services.layerState.isExplicitLayerStateOrigin = () => false;
  const layer = createSatellitesLayer({ source, services });

  // Cold catalog (no satellites loaded yet)
  assert.deepEqual(layer.getNextIssPass({ latDeg: 30, lonDeg: -97 }), {
    status: 'no-tle',
  });
  assert.deepEqual(
    layer.getNextSatellitePass(25544, { latDeg: 30, lonDeg: -97 }),
    { status: 'no-tle' },
  );

  // String NORAD ID coercion
  assert.deepEqual(
    layer.getNextSatellitePass('25544', { latDeg: 30, lonDeg: -97 }),
    { status: 'no-tle' },
  );

  // Invalid / non-finite ID handling
  assert.deepEqual(
    layer.getNextSatellitePass(NaN, { latDeg: 30, lonDeg: -97 }),
    { status: 'no-tle' },
  );
  assert.deepEqual(
    layer.getNextSatellitePass(null, { latDeg: 30, lonDeg: -97 }),
    { status: 'no-tle' },
  );

  // Populated catalog: verify numeric and string coercion succeed
  const L1 =
    '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
  const L2 =
    '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';
  const satrec = twoline2satrec(L1, L2);
  layer._setTrackedSatelliteRefreshStateForTest({
    noradId: 25544,
    name: 'ISS (ZARYA)',
    satrec,
  });

  const FROM_MS = 1221868800000;
  const numericResult = layer.getNextSatellitePass(25544, {
    latDeg: 30.2672,
    lonDeg: -97.7431,
    fromMs: FROM_MS,
  });
  assert.equal(numericResult.status, 'ok');
  assert.ok(numericResult.pass);

  const stringResult = layer.getNextSatellitePass('25544', {
    latDeg: 30.2672,
    lonDeg: -97.7431,
    fromMs: FROM_MS,
  });
  assert.equal(stringResult.status, 'ok');
  assert.deepEqual(stringResult, numericResult);

  const issResult = layer.getNextIssPass({
    latDeg: 30.2672,
    lonDeg: -97.7431,
    fromMs: FROM_MS,
  });
  assert.equal(issResult.status, 'ok');
  assert.deepEqual(issResult, numericResult);

  // Non-existent satellite ID in populated catalog
  assert.deepEqual(
    layer.getNextSatellitePass(99999, {
      latDeg: 30.2672,
      lonDeg: -97.7431,
      fromMs: FROM_MS,
    }),
    { status: 'no-tle' },
  );
});
