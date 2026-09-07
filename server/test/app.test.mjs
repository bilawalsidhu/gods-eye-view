import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { ReadinessState } from '../dist/readiness.js';
import { COMPATIBILITY_ROUTE_CONTRACTS } from '../dist/compatibility.js';

async function createApp(overrides = {}, adapters = {}, compatibilityBridge) {
  const readiness = new ReadinessState();
  const app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      ...overrides,
    }),
    adapters,
    readiness,
    compatibilityBridge,
  });
  return { app, readiness };
}

test('serves liveness and readiness endpoints', async (context) => {
  const { app } = await createApp();
  context.after(() => app.close());

  const live = await app.inject({ method: 'GET', url: '/health/live' });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), { status: 'ok' });

  const ready = await app.inject({ method: 'GET', url: '/health/ready' });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().status, 'ready');
});

test('propagates a valid correlation ID', async (context) => {
  const { app } = await createApp();
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/api/status',
    headers: { 'x-correlation-id': 'test-correlation-42' },
  });
  assert.equal(response.headers['x-correlation-id'], 'test-correlation-42');
});

test('returns problem JSON for unknown API routes', async (context) => {
  const { app } = await createApp();
  context.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/api/missing' });
  assert.equal(response.statusCode, 404);
  assert.match(response.headers['content-type'], /^application\/problem\+json/);
  assert.equal(response.json().status, 404);
  assert.ok(response.json().correlationId);
});

test('enforces request body limits', async (context) => {
  const foundry = { complete: async () => ({ choices: [] }) };
  const { app } = await createApp({ REQUEST_BODY_LIMIT_BYTES: '1024' }, { foundry });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/foundry/chat',
    headers: { 'content-type': 'application/json' },
    payload: { messages: [{ role: 'user', content: 'x'.repeat(2_000) }] },
  });
  assert.equal(response.statusCode, 413);
  assert.match(response.headers['content-type'], /^application\/problem\+json/);
});

test('mounts exact Azure Maps contracts without exporting managed identity tokens', async (context) => {
  const calls = [];
  const maps = {
    searchAddress: async (...args) => { calls.push(['search', ...args]); return { results: [{ id: 'one' }] }; },
    reverseGeocode: async (...args) => { calls.push(['reverse', ...args]); return { addresses: [] }; },
    route: async (...args) => { calls.push(['route', ...args]); return { routes: [] }; },
    trafficStatus: () => ({ configured: true, available: true, reason: null }),
    tile: async () => ({ body: Buffer.from([1, 2, 3]), contentType: 'image/png' }),
    attribution: async () => ['© Test supplier'],
  };
  const { app } = await createApp({}, { maps });
  context.after(() => app.close());

  assert.equal((await app.inject('/api/azure/maps/search?query=Oslo')).statusCode, 200);
  assert.equal((await app.inject('/api/azure/maps/reverse-geocode?lat=60&lon=10')).statusCode, 200);
  assert.equal((await app.inject({
    method: 'POST',
    url: '/api/azure/maps/route',
    payload: { coordinates: [{ latitude: 60, longitude: 10 }, { latitude: 61, longitude: 11 }] },
  })).statusCode, 200);
  assert.equal((await app.inject('/api/azure/maps/traffic/status')).statusCode, 200);
  const tile = await app.inject('/api/azure/maps/tile?tilesetId=microsoft.imagery&zoom=2&x=1&y=1');
  assert.equal(tile.statusCode, 200);
  assert.equal(tile.headers['content-type'], 'image/png');
  assert.deepEqual(tile.rawPayload, Buffer.from([1, 2, 3]));
  assert.deepEqual(
    (await app.inject('/api/azure/maps/attribution?style=satellite&zoom=2&bounds=-10,-10,10,10')).json(),
    { attributions: ['© Test supplier'] },
  );
  const token = await app.inject('/api/azure/maps/token');
  assert.equal(token.statusCode, 410);
  assert.doesNotMatch(token.body, /Bearer|eyJ|access.?token/i);
  assert.deepEqual(calls.map(([name]) => name), ['search', 'reverse', 'route']);
});

test('enforces binary tile response limits', async (context) => {
  const maps = {
    trafficStatus: () => ({ configured: true, available: true, reason: null }),
    tile: async () => ({ body: Buffer.alloc(2_048), contentType: 'image/png' }),
  };
  const { app } = await createApp({ RESPONSE_LIMIT_BYTES: '1024' }, { maps });
  context.after(() => app.close());
  const response = await app.inject('/api/azure/maps/tile?tilesetId=microsoft.imagery&zoom=2&x=1&y=1');
  assert.equal(response.statusCode, 500);
  assert.match(response.headers['content-type'], /^application\/problem\+json/);
});

test('returns only Foundry ephemeral realtime material and clamps HUD output to five words', async (context) => {
  const foundry = {
    createRealtimeClientSecret: async () => ({
      value: 'ephemeral-only',
      expiresAt: 12345,
      endpoint: 'https://example.openai.azure.com',
      deployment: 'realtime',
      model: 'realtime',
    }),
    createHudSummary: async () => 'One two three four five six seven',
  };
  const { app } = await createApp({}, { foundry });
  context.after(() => app.close());

  const realtime = await app.inject({
    method: 'POST',
    url: '/api/azure/foundry/realtime/client-secret',
    payload: {},
  });
  assert.equal(realtime.statusCode, 200);
  assert.deepEqual(realtime.json(), {
    clientSecret: { value: 'ephemeral-only', expiresAt: 12345 },
    endpoint: 'https://example.openai.azure.com',
    deployment: 'realtime',
    model: 'realtime',
  });
  assert.doesNotMatch(realtime.body, /managed.?identity|authorization|refresh.?token/i);

  const hud = await app.inject({
    method: 'POST',
    url: '/api/azure/foundry/hud-summary',
    payload: { prompt: 'scene' },
  });
  assert.equal(hud.statusCode, 200);
  assert.equal(hud.json().summary, 'One two three four five');
});

test('mounts every retained compatibility route through the production bridge', async (context) => {
  const seen = [];
  const bridge = {
    handle: async (request) => {
      seen.push(request.contractId);
      return { status: 200, body: { contractId: request.contractId } };
    },
  };
  const { app } = await createApp({}, {}, bridge);
  context.after(() => app.close());

  for (const contract of COMPATIBILITY_ROUTE_CONTRACTS) {
    const url = contract.url.replace('*', 'sample');
    const response = await app.inject({
      method: contract.method,
      url,
      payload: contract.method === 'POST' ? 'data=test' : undefined,
      headers: contract.method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined,
    });
    assert.equal(response.statusCode, 200, `${contract.id} was not mounted`);
  }
  assert.deepEqual(seen.sort(), COMPATIBILITY_ROUTE_CONTRACTS.map(({ id }) => id).sort());
});

test('exposes AIS snapshot and track contracts with explicit provenance', async (context) => {
  let started = 0;
  const ais = {
    start: () => { started += 1; },
    stop: () => {},
    snapshot: () => ({
      rows: [{ mmsi: '123456789' }],
      source: 'AISStream',
      provenance: 'Best-effort test data',
      status: 'live',
      error: null,
      refreshing: false,
      newestPositionAt: null,
      lastMessageAt: 1,
      silentForMs: 0,
      reconnectAttempt: 0,
      nextAttemptAt: null,
      staleAfterMs: 1000,
      watchdog: 'armed',
    }),
    track: () => [{ lat: 60, lon: 10, t: 1 }],
  };
  const { app } = await createApp({}, { ais });
  context.after(() => app.close());

  const snapshot = await app.inject('/api/ais-live');
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().source, 'AISStream');
  assert.match(snapshot.json().provenance, /Best-effort/);
  const track = await app.inject('/api/ais-live/track?mmsi=123456789');
  assert.equal(track.statusCode, 200);
  assert.equal(track.json().samples.length, 1);
  assert.equal(started, 1);
});
