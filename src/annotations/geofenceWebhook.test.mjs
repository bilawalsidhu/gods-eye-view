import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidWebhookUrl,
  buildBreachPayload,
  dispatchBreach,
} from './geofenceWebhook.js';
import { createGeofenceMonitor } from './geofenceMonitor.js';

test('webhook url validation', () => {
  assert.equal(isValidWebhookUrl('https://example.com/hook'), true);
  assert.equal(isValidWebhookUrl('http://localhost:3000/'), true);
  assert.equal(isValidWebhookUrl(''), false);
  assert.equal(isValidWebhookUrl('not-a-url'), false);
  assert.equal(isValidWebhookUrl('ftp://example.com'), false);
});

test('buildBreachPayload contains entityId, timestamp, coordinates, speed', () => {
  const entity = {
    id: 'ABC123',
    lon: 12.34,
    lat: 56.78,
    layerKey: 'flights',
    _raw: { speedMps: 250, icao24: 'ABC123' },
  };
  const payload = buildBreachPayload(entity, {
    now: () => '2026-01-01T00:00:00.000Z',
  });
  assert.equal(payload.entityId, 'ABC123');
  assert.equal(payload.timestamp, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(payload.coordinates, { lon: 12.34, lat: 56.78 });
  assert.equal(payload.speed, 250);
  assert.equal(payload.layer, 'flights');
});

test('buildBreachPayload extracts speed from various fields', () => {
  assert.equal(
    buildBreachPayload({ id: 'a', lon: 0, lat: 0, _raw: { speedKts: 150 } })
      .speed,
    150,
  );
  assert.equal(
    buildBreachPayload({ id: 'b', lon: 0, lat: 0, speed: 99 }).speed,
    99,
  );
  assert.equal(buildBreachPayload({ id: 'c', lon: 0, lat: 0 }).speed, null);
});

test('dispatchBreach POSTs JSON', async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200 };
  };
  const payload = {
    entityId: 'X',
    timestamp: 't',
    coordinates: { lon: 1, lat: 2 },
    speed: 10,
  };
  await dispatchBreach('https://example.com/hook', payload, fakeFetch);
  assert.equal(captured.url, 'https://example.com/hook');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.opts.body), payload);
});

test('dispatchBreach rejects invalid url', async () => {
  await assert.rejects(() =>
    dispatchBreach('bad', {}, async () => ({ ok: true })),
  );
});

test('monitor dispatches POST immediately on confirmed breach, deduped', async () => {
  const square = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 1, lat: 1 },
    { lon: 0, lat: 1 },
  ];
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true };
  };
  let records = [{ icao24: 'A1', lat: 5, lon: 5, speedMps: 100 }];
  const fakeManager = {
    layers: new Map([
      [
        'flights',
        { enabled: true, module: { getAnalystRecords: () => records } },
      ],
    ]),
    subscribeActivity: () => () => {},
    subscribe: () => () => {},
  };
  const monitor = createGeofenceMonitor({
    getPolygon: () => square,
    dataManager: fakeManager,
    fetchImpl: fakeFetch,
    now: () => '2026-01-02T00:00:00.000Z',
  });
  monitor.setWebhookUrl('https://example.com/breach');

  // outside -> no POST
  monitor.evaluateAll();
  assert.equal(calls.length, 0);

  // enter -> POST
  records = [{ icao24: 'A1', lat: 0.5, lon: 0.5, speedMps: 123 }];
  monitor.evaluateAll();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/breach');
  assert.equal(calls[0].body.entityId, 'A1');
  assert.equal(calls[0].body.timestamp, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(calls[0].body.coordinates, { lon: 0.5, lat: 0.5 });
  assert.equal(calls[0].body.speed, 123);

  // stay inside -> no duplicate POST
  monitor.evaluateAll();
  assert.equal(calls.length, 1);

  // exit and re-enter -> second POST
  records = [{ icao24: 'A1', lat: 5, lon: 5, speedMps: 100 }];
  monitor.evaluateAll();
  records = [{ icao24: 'A1', lat: 0.5, lon: 0.5, speedMps: 124 }];
  monitor.evaluateAll();
  assert.equal(calls.length, 2);

  monitor.destroy();
});

test('monitor setWebhookUrl validation', () => {
  const monitor = createGeofenceMonitor({
    getPolygon: () => null,
    dataManager: {
      layers: new Map(),
      subscribeActivity: () => () => {},
      subscribe: () => () => {},
    },
  });
  assert.equal(monitor.setWebhookUrl('https://example.com'), true);
  assert.equal(monitor.getWebhookUrl(), 'https://example.com');
  assert.equal(monitor.setWebhookUrl('bad'), false);
  assert.equal(monitor.setWebhookUrl(''), true);
  assert.equal(monitor.getWebhookUrl(), null);
  monitor.destroy();
});
