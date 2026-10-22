import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidWebhookUrl,
  buildBreachPayload,
  dispatchBreach,
  KNOTS_TO_MPS,
} from './geofenceWebhook.js';
import { createGeofenceMonitor } from './geofenceMonitor.js';

test('webhook url validation: https only, public hosts, no credentials', () => {
  assert.equal(isValidWebhookUrl('https://example.com/hook'), true);
  assert.equal(
    isValidWebhookUrl('https://hooks.slack.com/services/T/B/X'),
    true,
  );
  assert.equal(isValidWebhookUrl('https://8.8.8.8/hook'), true);
  assert.equal(isValidWebhookUrl('https://172.32.0.1/hook'), true);
  assert.equal(isValidWebhookUrl('https://[2600:1901:0:4665::]/hook'), true);
  assert.equal(isValidWebhookUrl('https://[::ffff:8.8.8.8]/hook'), true);
  // Plain http is blocked by the app's CSP connect-src, so it is rejected.
  assert.equal(isValidWebhookUrl('http://example.com/hook'), false);
  assert.equal(isValidWebhookUrl('http://localhost:3000/'), false);
  assert.equal(isValidWebhookUrl(''), false);
  assert.equal(isValidWebhookUrl('not-a-url'), false);
  assert.equal(isValidWebhookUrl('ftp://example.com'), false);
  assert.equal(isValidWebhookUrl('https://user:pass@example.com/'), false);
  assert.equal(isValidWebhookUrl('https://user@example.com/'), false);
});

test('webhook url validation: loopback, private and link-local rejected', () => {
  for (const url of [
    'https://localhost/hook',
    'https://localhost:3000/hook',
    'https://LOCALHOST/hook',
    'https://foo.localhost/hook',
    'https://127.0.0.1/hook',
    'https://127.1/hook',
    'https://0x7f.0.0.1/hook',
    'https://2130706433/hook',
    'https://10.0.0.8/hook',
    'https://172.16.4.2/hook',
    'https://172.31.255.1/hook',
    'https://192.168.1.5/hook',
    'https://169.254.10.20/hook',
    'https://0.0.0.0/hook',
    'https://[::1]/hook',
    'https://[::]/hook',
    'https://[fe80::1]/hook',
    'https://[fc00::5]/hook',
    'https://[::ffff:127.0.0.1]/hook',
    'https://[::ffff:10.1.2.3]/hook',
  ]) {
    assert.equal(isValidWebhookUrl(url), false, url);
  }
});

test('buildBreachPayload contains entityId, timestamp, coordinates, speedMps', () => {
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
  assert.equal(payload.speedMps, 250);
  assert.equal(payload.speedUnit, 'm/s');
  assert.equal(payload.layer, 'flights');
});

test('buildBreachPayload converts knots to m/s and ignores unknown units', () => {
  assert.equal(
    buildBreachPayload({ id: 'a', lon: 0, lat: 0, _raw: { speedKts: 150 } })
      .speedMps,
    150 * KNOTS_TO_MPS,
  );
  assert.equal(
    buildBreachPayload({
      id: 'b',
      lon: 0,
      lat: 0,
      _raw: { velocityMps: 42 },
    }).speedMps,
    42,
  );
  // Bare speed/velocity mix m/s and knots by layer, so neither is trusted.
  assert.equal(
    buildBreachPayload({ id: 'c', lon: 0, lat: 0, speed: 99 }).speedMps,
    null,
  );
  assert.equal(
    buildBreachPayload({ id: 'd', lon: 0, lat: 0, velocity: 99 }).speedMps,
    null,
  );
  assert.equal(buildBreachPayload({ id: 'e', lon: 0, lat: 0 }).speedMps, null);
});

test('dispatchBreach POSTs JSON with an abort signal', async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200 };
  };
  const payload = {
    entityId: 'X',
    timestamp: 't',
    coordinates: { lon: 1, lat: 2 },
    speedMps: 10,
    speedUnit: 'm/s',
  };
  await dispatchBreach('https://example.com/hook', payload, fakeFetch);
  assert.equal(captured.url, 'https://example.com/hook');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(captured.opts.body), payload);
  assert.ok(captured.opts.signal instanceof AbortSignal);
});

test('dispatchBreach rejects invalid url', async () => {
  await assert.rejects(() =>
    dispatchBreach('bad', {}, async () => ({ ok: true })),
  );
  await assert.rejects(() =>
    dispatchBreach('http://example.com/hook', {}, async () => ({ ok: true })),
  );
});

test('dispatchBreach times out a hanging receiver', async () => {
  const hanging = (url, opts) =>
    new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  await assert.rejects(
    () =>
      dispatchBreach('https://example.com/hook', {}, hanging, {
        timeoutMs: 20,
      }),
    /timed out after 20ms/,
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
  // The POST is fire-and-forget; flush the microtask before asserting.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/breach');
  assert.equal(calls[0].body.entityId, 'A1');
  assert.equal(calls[0].body.timestamp, '2026-01-02T00:00:00.000Z');
  assert.deepEqual(calls[0].body.coordinates, { lon: 0.5, lat: 0.5 });
  assert.equal(calls[0].body.speedMps, 123);
  assert.equal(calls[0].body.speedUnit, 'm/s');

  // stay inside -> no duplicate POST
  monitor.evaluateAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);

  // exit and re-enter -> second POST
  records = [{ icao24: 'A1', lat: 5, lon: 5, speedMps: 100 }];
  monitor.evaluateAll();
  records = [{ icao24: 'A1', lat: 0.5, lon: 0.5, speedMps: 124 }];
  monitor.evaluateAll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);

  monitor.destroy();
});

test('monitor swallows failed POSTs: no unhandled rejection, error recorded', async () => {
  const square = [
    { lon: 0, lat: 0 },
    { lon: 1, lat: 0 },
    { lon: 1, lat: 1 },
    { lon: 0, lat: 1 },
  ];
  let records = [{ icao24: 'F1', lat: 5, lon: 5 }];
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
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });
  monitor.setWebhookUrl('https://example.com/breach');
  monitor.evaluateAll();
  records = [{ icao24: 'F1', lat: 0.5, lon: 0.5 }];
  // A rejection here would surface as an unhandled rejection and fail the run.
  monitor.evaluateAll();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(monitor.getLastWebhookError(), /connection refused/);
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
  assert.equal(monitor.setWebhookUrl('http://example.com'), false);
  assert.equal(monitor.setWebhookUrl('https://127.0.0.1/x'), false);
  assert.equal(monitor.setWebhookUrl(''), true);
  assert.equal(monitor.getWebhookUrl(), null);
  monitor.destroy();
});

test('monitor diagnostics report webhook presence, never the URL', () => {
  const monitor = createGeofenceMonitor({
    getPolygon: () => null,
    dataManager: {
      layers: new Map(),
      subscribeActivity: () => () => {},
      subscribe: () => () => {},
    },
  });
  assert.equal(monitor.diagnostics().hasWebhookUrl, false);
  monitor.setWebhookUrl('https://hooks.slack.com/services/T/B/secret');
  const diag = monitor.diagnostics();
  assert.equal(diag.hasWebhookUrl, true);
  assert.ok(!('webhookUrl' in diag));
  assert.ok(!JSON.stringify(diag).includes('secret'));
  monitor.destroy();
});
