/**
 * Offline tests for the `vessels` OnDemand tool plugin (server/tools/vessels.js)
 * through the real tools route + registry. No network: the demo replay and
 * `empty` paths never fetch, the AISHub path gets a mocked fetch and the
 * AISStream path is pointed at a refused localhost socket.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createToolsHandler } from '../../server/serverless/tools-route.js';
import { toolIndex } from '../../server/tools/registry.js';
import {
  plugin,
  tools,
  bboxFromPointRadius,
  resolveSceneBbox,
  normaliseVesselRow,
  distanceKm,
} from '../../server/tools/vessels.js';
import { DEMO_REPLAY_AREA } from '../../server/providers/vessels/ais-demo-replay.js';

const ENV_KEYS = [
  'AISSTREAM_API_KEY',
  'AISHUB_USERNAME',
  'AISSTREAM_URL',
  'AISSTREAM_COLLECT_MS',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

before(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});
after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function invoke(handler, url, method = 'GET') {
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => {
        headers[k.toLowerCase()] = v;
      },
      end: (body) =>
        resolve({
          status: res.statusCode,
          headers,
          body: body ? JSON.parse(body) : null,
          text: body || '',
        }),
    };
    handler({ url, method, on() {} }, res);
  });
}

const handler = createToolsHandler({ index: toolIndex() });
const GALVESTON = 'lat=29.45&lon=-94.85';

test('plugin descriptor: id, name, category, ≥3 starters, bounded-collector + demo + incident wording', () => {
  assert.equal(plugin.id, 'vessels');
  assert.equal(plugin.name, 'OnDemand Spatial Live Vessels (AIS)');
  assert.equal(plugin.category, 'Research');
  assert.ok(plugin.conversationStarters.length >= 3);
  assert.match(plugin.description, /8 s/);
  assert.match(plugin.description, /AISSTREAM_API_KEY/);
  assert.match(plugin.description, /demo replay/i);
  assert.match(plugin.description, /degraded/);
  assert.match(plugin.description, /aisstream\/aisstream\/issues\/15/);
  assert.match(plugin.description, /13 March 2026/);
  assert.deepEqual(
    tools.map((t) => [t.name, t.cacheSeconds]),
    [
      ['vessels_in_bbox', 20],
      ['vessel_by_mmsi', 20],
    ],
  );
});

test('geometry helpers: point ± radius box, explicit corners, distance, row normalisation', () => {
  const box = bboxFromPointRadius(29.45, -94.85, 60);
  assert.ok(box.lamin < 29.45 && box.lamax > 29.45);
  assert.ok(box.lomin < -94.85 && box.lomax > -94.85);
  assert.ok(Math.abs(box.lamax - box.lamin - 2 * (60 / 111.32)) < 0.01);
  // longitude half-width grows with latitude
  const north = bboxFromPointRadius(60, 10, 60);
  assert.ok(north.lomax - north.lomin > box.lomax - box.lomin);
  // clamped at the pole, still non-degenerate
  const pole = bboxFromPointRadius(89.9, 0, 300);
  assert.equal(pole.lamax, 90);
  assert.ok(pole.lamin < pole.lamax);

  const explicit = resolveSceneBbox({
    lat: 1,
    lon: 2,
    radiusKm: 60,
    lamin: 28.9,
    lomin: -95.3,
    lamax: 29.8,
    lomax: -94.1,
  });
  assert.equal(explicit.explicit, true);
  assert.deepEqual(explicit.bbox, {
    lamin: 28.9,
    lomin: -95.3,
    lamax: 29.8,
    lomax: -94.1,
  });
  assert.equal(
    resolveSceneBbox({ lat: 1, lon: 2, radiusKm: 60, lamin: 1 }).error.code,
    'invalid_param',
  );
  assert.equal(
    resolveSceneBbox({ lat: 1, lon: 2, radiusKm: 60, lamin: 5, lomin: 1, lamax: 4, lomax: 2 }).error.code,
    'invalid_param',
  );
  assert.ok(Math.abs(distanceKm(29.45, -94.85, 29.45, -94.85)) < 1e-9);
  assert.ok(Math.abs(distanceKm(0, 0, 0, 1) - 111.19) < 0.2);

  const vessel = normaliseVesselRow(
    {
      mmsi: 999000001,
      name: ' DEMO REPLAY 1 ',
      imo: '',
      type: 'Demo replay (not live AIS)',
      destination: 'BAYPORT (DEMO)',
      lat: 29.5,
      lon: -94.9,
      speed: '12',
      course: 312.5,
      heading: 313,
      last_position_epoch: 1_800_000_000,
    },
    { lat: 29.45, lon: -94.85 },
  );
  assert.deepEqual(Object.keys(vessel), [
    'mmsi',
    'name',
    'imo',
    'type',
    'destination',
    'lat',
    'lon',
    'speedKt',
    'courseDeg',
    'headingDeg',
    'lastPositionUtc',
    'distanceKm',
  ]);
  assert.equal(vessel.mmsi, '999000001');
  assert.equal(vessel.name, 'DEMO REPLAY 1');
  assert.equal(vessel.imo, null);
  assert.equal(vessel.speedKt, 12);
  assert.equal(vessel.lastPositionUtc, '2027-01-15T08:00:00.000Z');
  assert.ok(vessel.distanceKm > 6 && vessel.distanceKm < 9);
});

test('vessels_in_bbox: Galveston Bay without AISSTREAM_API_KEY is the labelled demo replay (degraded), nearest first', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network must not be used on the demo replay path');
  });
  const res = await invoke(handler, `/vessels_in_bbox?${GALVESTON}&limit=5`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers['x-tools-route'], 'ondemand-spatial');
  assert.match(res.headers['cache-control'], /s-maxage=20/);
  const { body } = res;
  assert.equal(body.ok, true);
  assert.equal(body.tool, 'vessels_in_bbox');
  assert.equal(body.params.radiusKm, 60);
  assert.equal(body.params.maxRows, 2000);
  assert.equal(body.data.collectorMode, 'demo');
  assert.equal(body.data.status, 'degraded');
  assert.equal(body.data.source, 'Demo replay');
  assert.equal(body.data.scene.explicitBox, false);
  assert.equal(body.data.count, 5);
  assert.ok(body.data.total >= 5);
  assert.equal(body.data.vessels.length, 5);
  assert.match(body.data.snapshotUtc, /^\d{4}-\d{2}-\d{2}T/);
  for (const vessel of body.data.vessels) {
    assert.match(vessel.mmsi, /^9990000\d\d$/);
    assert.match(vessel.name, /^DEMO REPLAY \d+$/);
    assert.equal(vessel.type, 'Demo replay (not live AIS)');
    assert.equal(typeof vessel.distanceKm, 'number');
    assert.match(vessel.lastPositionUtc, /Z$/);
  }
  const distances = body.data.vessels.map((v) => v.distanceKm);
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  assert.equal(body.provider.status, 'degraded');
  assert.equal(body.provider.source, 'Demo replay');
  assert.match(body.provider.error, /AISSTREAM_API_KEY not set/);
  assert.equal(body.provenance.completeness.status, 'bounded');
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('vessels_in_bbox: all four corners define the box; a partial set is a 400', async () => {
  const explicit = await invoke(
    handler,
    `/vessels_in_bbox?${GALVESTON}&lamin=29.2&lomin=-95.0&lamax=29.7&lomax=-94.5&limit=50`,
  );
  assert.equal(explicit.status, 200, explicit.text);
  assert.deepEqual(explicit.body.data.bbox, {
    lamin: 29.2,
    lomin: -95.0,
    lamax: 29.7,
    lomax: -94.5,
  });
  assert.equal(explicit.body.data.scene.explicitBox, true);
  assert.equal(explicit.body.data.scene.radiusKm, null);
  for (const v of explicit.body.data.vessels) {
    assert.ok(v.lat >= 29.2 && v.lat <= 29.7 && v.lon >= -95.0 && v.lon <= -94.5);
  }
  const partial = await invoke(handler, `/vessels_in_bbox?${GALVESTON}&lamin=29.2`);
  assert.equal(partial.status, 400);
  assert.equal(partial.body.error.code, 'invalid_param');
});

test('vessels_in_bbox: a box outside the demo coverage is ok:true, count 0, status empty with the statusMessage', async () => {
  const res = await invoke(handler, '/vessels_in_bbox?lat=51.9&lon=4.4&radiusKm=60');
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.status, 'empty');
  assert.equal(res.body.data.count, 0);
  assert.equal(res.body.data.total, 0);
  assert.deepEqual(res.body.data.vessels, []);
  assert.match(res.body.data.statusMessage, /^No vessels in scene/);
  assert.equal(res.body.provider.status, 'degraded');
});

test('vessels_in_bbox: validation through the real registry (unknown_param, missing_param, invalid_param)', async () => {
  const unknown = await invoke(handler, `/vessels_in_bbox?${GALVESTON}&bogus=1`);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'unknown_param');
  assert.equal(unknown.body.error.param, 'bogus');
  assert.equal(unknown.headers['cache-control'], 'no-store');
  const missing = await invoke(handler, '/vessels_in_bbox?lat=29.45');
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'missing_param');
  assert.equal(missing.body.error.param, 'lon');
  const radius = await invoke(handler, `/vessels_in_bbox?${GALVESTON}&radiusKm=1000`);
  assert.equal(radius.status, 400);
  assert.equal(radius.body.error.code, 'invalid_param');
  const limit = await invoke(handler, `/vessels_in_bbox?${GALVESTON}&limit=0`);
  assert.equal(limit.status, 400);
  assert.equal(limit.body.error.param, 'limit');
  const maxRows = await invoke(handler, `/vessels_in_bbox?${GALVESTON}&maxRows=99999`);
  assert.equal(maxRows.status, 400);
  assert.equal(maxRows.body.error.param, 'maxRows');
});

test('vessel_by_mmsi: a demo MMSI resolves in the default Texas Gulf box with its track', async () => {
  const res = await invoke(handler, '/vessel_by_mmsi?mmsi=999000001');
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers['cache-control'], /s-maxage=20/);
  const { data } = res.body;
  assert.deepEqual(data.bbox, { ...DEMO_REPLAY_AREA });
  assert.equal(data.scene.defaultDemoArea, true);
  assert.equal(data.collectorMode, 'demo');
  assert.equal(data.status, 'degraded');
  assert.equal(data.vessel.mmsi, '999000001');
  assert.equal(data.vessel.name, 'DEMO REPLAY 1');
  assert.equal(typeof data.vessel.lat, 'number');
  assert.ok(data.track.samples.length > 10);
  assert.equal(data.track.source, 'Demo replay');
  for (const sample of data.track.samples) {
    assert.equal(typeof sample.lat, 'number');
    assert.equal(typeof sample.lon, 'number');
    assert.match(sample.timeUtc, /Z$/);
  }
  assert.equal(res.body.provider.source, 'Demo replay');

  const scoped = await invoke(handler, `/vessel_by_mmsi?mmsi=999000001&${GALVESTON}&radiusKm=200`);
  assert.equal(scoped.status, 200, scoped.text);
  assert.equal(scoped.body.data.scene.defaultDemoArea, false);
  assert.equal(scoped.body.data.scene.radiusKm, 200);
  assert.equal(scoped.body.data.vessel.mmsi, '999000001');
});

test('vessel_by_mmsi: not found → 404 not_found; malformed MMSI / lone lat → 400', async () => {
  const missing = await invoke(handler, '/vessel_by_mmsi?mmsi=123456789');
  assert.equal(missing.status, 404, missing.text);
  assert.equal(missing.body.ok, false);
  assert.equal(missing.body.error.code, 'not_found');
  assert.match(missing.body.error.message, /^MMSI 123456789 not in the current scene snapshot/);
  assert.equal(missing.body.provider.source, 'Demo replay');
  assert.equal(missing.headers['cache-control'], 'no-store');
  const malformed = await invoke(handler, '/vessel_by_mmsi?mmsi=12ab');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'invalid_param');
  const loneLat = await invoke(handler, '/vessel_by_mmsi?mmsi=999000001&lat=29.45');
  assert.equal(loneLat.status, 400);
  assert.equal(loneLat.body.error.code, 'missing_param');
  assert.equal(loneLat.body.error.param, 'lon');
  const unknown = await invoke(handler, '/vessel_by_mmsi?mmsi=999000001&imo=1');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'unknown_param');
});

test('a 503 from the AIS route (AISHub rejected) is ok:false with the route provider and no env value leaks', async (t) => {
  const sentinel = 'sentinel-aishub-user-7f3c9';
  process.env.AISHUB_USERNAME = sentinel;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    new Response('unauthorized', { status: 401 }),
  );
  try {
    const res = await invoke(handler, '/vessels_in_bbox?lat=1.25&lon=103.8&radiusKm=40');
    assert.equal(res.status, 503, res.text);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'upstream_unavailable');
    assert.match(res.body.error.message, /AISHub/);
    assert.equal(res.body.provider.status, 'unavailable');
    assert.equal(res.body.provider.source, 'AISHub');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(fetchMock.mock.callCount() >= 1);
    assert.ok(!res.text.includes(sentinel), 'AISHUB_USERNAME value must never appear in a tool response');
  } finally {
    delete process.env.AISHUB_USERNAME;
  }
});

test('a refused AISStream socket is a 503 error envelope and AISSTREAM_API_KEY never leaks', async () => {
  const sentinel = 'sentinel-aisstream-key-0b1d2';
  process.env.AISSTREAM_API_KEY = sentinel;
  process.env.AISSTREAM_URL = 'ws://127.0.0.1:9/';
  process.env.AISSTREAM_COLLECT_MS = '400';
  try {
    const res = await invoke(handler, '/vessels_in_bbox?lat=-33.86&lon=151.2&radiusKm=40');
    assert.equal(res.status, 503, res.text);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'upstream_unavailable');
    assert.match(res.body.error.message, /AISStream/);
    assert.equal(res.body.provider.source, 'AISStream');
    assert.equal(res.body.provider.status, 'unavailable');
    assert.ok(!res.text.includes(sentinel), 'AISSTREAM_API_KEY value must never appear in a tool response');
    assert.ok(!res.text.includes('127.0.0.1:9'), 'the upstream URL must not be echoed');
  } finally {
    delete process.env.AISSTREAM_API_KEY;
    delete process.env.AISSTREAM_URL;
    delete process.env.AISSTREAM_COLLECT_MS;
  }
});
