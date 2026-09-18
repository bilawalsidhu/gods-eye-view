import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createTrafficSource } from './source.js';
const bounds = { south: 30.267, west: -97.744, north: 30.268, east: -97.743 };
const fixture = readFileSync(
  new URL(
    '../../data/fixtures/tomtom-flow-austin-12-935-1686.pbf',
    import.meta.url,
  ),
);
test('flow caches and diagnostics belong to their constructed source', async () => {
  let requestsA = 0,
    requestsB = 0;
  const a = createTrafficSource({
    fetchImpl: async () => {
      requestsA++;
      return new Response(fixture);
    },
  });
  const b = createTrafficSource({
    fetchImpl: async () => {
      requestsB++;
      return new Response(fixture);
    },
  });
  const first = await a.fetchFlowForBounds(bounds);
  assert.ok(first.length > 0);
  await a.fetchFlowForBounds(bounds);
  assert.equal(requestsA, 1);
  assert.equal(b.getFlowSessionStats().tilesFetched, 0);
  b.resetFlowTileCache();
  await a.fetchFlowForBounds(bounds);
  assert.equal(requestsA, 1);
  await b.fetchFlowForBounds(bounds);
  assert.equal(requestsB, 1);
});
test('a cancelled flow body cannot refill its source cache', async () => {
  const controller = new AbortController();
  let calls = 0;
  const source = createTrafficSource({
    fetchImpl: async () => ({
      ok: true,
      arrayBuffer: async () => {
        calls++;
        if (calls === 1) controller.abort();
        return fixture;
      },
    }),
  });
  await assert.rejects(
    source.fetchFlowForBounds(bounds, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  await source.fetchFlowForBounds(bounds);
  assert.equal(
    calls,
    2,
    'cancelled bytes were not admitted to the decode cache',
  );
});
test('road requests have finite bounds and retain the two-pass query', async () => {
  const calls = [];
  const source = createTrafficSource({
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response('{"elements":[]}');
    },
  });
  await assert.rejects(
    source.requestRoads({ ...bounds, north: Infinity }),
    /bounded road viewport/,
  );
  await assert.rejects(
    source.requestRoads(bounds, { timeoutSec: '25];out;' }),
    /bounded road viewport/,
  );
  assert.equal(calls.length, 0);
  await source.requestRoads(bounds, { majorOnly: true, timeoutSec: 8 });
  assert.equal(calls[0][0], '/api/overpass');
  const query = new URLSearchParams(calls[0][1].body).get('data');
  assert.match(query, /\[timeout:8\]/);
  assert.doesNotMatch(query, /residential/);
  await source.requestRoads(bounds);
  assert.match(
    new URLSearchParams(calls[1][1].body).get('data'),
    /residential/,
  );
});
test('malformed availability is an unavailable source rather than a keyless response', async () => {
  const source = createTrafficSource({
    fetchImpl: async () => new Response('{}'),
  });
  await assert.rejects(source.getStatus(), /Malformed traffic status/);
});

test('the status probe carries the scene point and returns the structured provider status', async () => {
  const urls = [];
  const source = createTrafficSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json(
        {
          hasKey: false,
          dailyCount: 0,
          budget: 40000,
          requestCount: 0,
          requestBudget: 2000,
          provider: {
            status: 'degraded',
            source: 'TomTom',
            fetchedAt: '2026-09-18T12:00:00.000Z',
            error:
              'TOMTOM_API_KEY not set — flow colours are simulated on live OSM roads',
          },
        },
        {
          headers: {
            'X-Provider-Status': 'degraded',
            'X-Provider-Source': 'TomTom',
            'X-Provider-Fetched-At': '2026-09-18T12:00:00.000Z',
            // Header fields are ASCII-only: the proxy's em dash arrives as '?'.
            'X-Provider-Error':
              'TOMTOM_API_KEY not set ? flow colours are simulated on live OSM roads',
          },
        },
      );
    },
  });
  const status = await source.getStatus({
    point: { lat: 30.2672, lon: -97.7431 },
  });
  assert.equal(urls[0], '/api/tomtom/status?point=30.267,-97.743');
  assert.equal(status.hasKey, false);
  assert.equal(status.providerStatus.status, 'degraded');
  assert.equal(status.providerStatus.source, 'TomTom');
  assert.equal(
    status.providerStatus.fetchedAtMs,
    Date.parse('2026-09-18T12:00:00.000Z'),
  );
  assert.equal(
    status.providerStatus.error,
    'TOMTOM_API_KEY not set — flow colours are simulated on live OSM roads',
    'the body reason (verbatim) outranks the ASCII-mangled header',
  );
  // No point / an invalid point → the plain status route; a legacy proxy body
  // without provider fields yields providerStatus null.
  const legacy = createTrafficSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return Response.json({ hasKey: true, dailyCount: 3, budget: 40000 });
    },
  });
  assert.equal((await legacy.getStatus()).providerStatus, null);
  assert.equal(urls[1], '/api/tomtom/status');
  await legacy.getStatus({ point: { lat: 120, lon: 0 } });
  assert.equal(urls[2], '/api/tomtom/status');
});

test('a failed flow tile carries the proxy code and provider reason', async () => {
  const source = createTrafficSource({
    fetchImpl: async () =>
      Response.json(
        {
          error: 'bad_key',
          provider: {
            status: 'unavailable',
            source: 'TomTom',
            error: 'TomTom rejected TOMTOM_API_KEY',
          },
        },
        {
          status: 503,
          headers: {
            'X-Provider-Status': 'unavailable',
            'X-Provider-Source': 'TomTom',
            'X-Provider-Error': 'TomTom rejected TOMTOM_API_KEY',
          },
        },
      ),
  });
  await assert.rejects(source.fetchFlowForBounds(bounds), (error) => {
    assert.match(error.message, /flow tile \d+\/\d+\/\d+: HTTP 503 bad_key/);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'bad_key');
    assert.equal(error.provider.status, 'unavailable');
    assert.equal(error.provider.error, 'TomTom rejected TOMTOM_API_KEY');
    return true;
  });
  // A non-JSON failure (legacy proxy, gateway page) still throws the HTTP code.
  const legacy = createTrafficSource({
    fetchImpl: async () => new Response('Bad Gateway', { status: 502 }),
  });
  await assert.rejects(legacy.fetchFlowForBounds(bounds), (error) => {
    assert.equal(error.message.endsWith('HTTP 502'), true);
    assert.equal(error.code, null);
    assert.equal(error.provider, null);
    return true;
  });
});

test('flow diagnostics report whether the latest tiles were live or last-good', async () => {
  let providerHeader = 'stale';
  const source = createTrafficSource({
    fetchImpl: async () =>
      new Response(fixture, {
        headers: {
          'X-Provider-Status': providerHeader,
          'X-Provider-Source': 'TomTom',
          'X-Provider-Fetched-At': '2026-09-18T12:00:00.000Z',
          ...(providerHeader === 'stale'
            ? { 'X-Provider-Error': 'TomTom flow tile unreachable (HTTP 502)' }
            : {}),
        },
      }),
  });
  assert.equal(source.getFlowSessionStats().provider, null);
  await source.fetchFlowForBounds(bounds);
  const stale = source.getFlowSessionStats().provider;
  assert.equal(stale.status, 'stale');
  assert.equal(stale.fetchedAtMs, Date.parse('2026-09-18T12:00:00.000Z'));
  assert.equal(stale.error, 'TomTom flow tile unreachable (HTTP 502)');
  // Cached tiles keep their provenance until the cache is cleared.
  await source.fetchFlowForBounds(bounds);
  assert.equal(source.getFlowSessionStats().provider.status, 'stale');
  source.resetFlowTileCache();
  providerHeader = 'live';
  await source.fetchFlowForBounds(bounds);
  assert.equal(source.getFlowSessionStats().provider.status, 'live');
  assert.equal(source.getFlowSessionStats().provider.error, null);
  // A legacy proxy without provider headers reports null, not a guess.
  const legacy = createTrafficSource({
    fetchImpl: async () => new Response(fixture),
  });
  await legacy.fetchFlowForBounds(bounds);
  assert.equal(legacy.getFlowSessionStats().provider, null);
});

test('traffic construction is inert and parameters belong to each layer', async () => {
  const { createTrafficLayer } = await import('./index.js');
  const source = createTrafficSource({
    fetchImpl: () => assert.fail('construction fetched data'),
  });
  const services = { credits: {}, render: {} };
  const a = createTrafficLayer({ services, source });
  const b = createTrafficLayer({ services, source });
  a.setParams({ densityScale: 2, speedScale: 3, uncoveredRoads: 'hide' });
  assert.equal(a.getParams().densityScale, 2);
  assert.equal(b.getParams().densityScale, 1);
  assert.equal(b.getParams().speedScale, 1);
  assert.equal(b.getParams().uncoveredRoads, 'sim');
});

test('road body parsing retains the source request cancellation signal', async () => {
  const controller = new AbortController();
  const source = createTrafficSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => {
        controller.abort();
        return { elements: [] };
      },
    }),
  });
  const response = await source.requestRoads(bounds, {
    signal: controller.signal,
  });
  await assert.rejects(response.json(), { name: 'AbortError' });
});

test('road sources decode direction and coordinates before scene construction', async () => {
  const geometry = [
    { lat: 30, lon: -97 },
    { lat: 30.001, lon: -97.001 },
  ];
  const source = createTrafficSource({
    fetchImpl: async () =>
      Response.json({
        elements: [
          { type: 'node', id: 1 },
          { type: 'way', geometry, tags: { highway: 'primary', oneway: '-1' } },
          { type: 'way', geometry, tags: { junction: 'roundabout' } },
          { type: 'way', geometry: [geometry[0]] },
        ],
      }),
  });
  assert.deepEqual(await (await source.requestRoads(bounds)).json(), {
    roads: [
      {
        coordinates: [
          [-97, 30],
          [-97.001, 30.001],
        ],
        type: 'primary',
        oneway: -1,
      },
      {
        coordinates: [
          [-97, 30],
          [-97.001, 30.001],
        ],
        type: 'unclassified',
        oneway: 1,
      },
    ],
  });
});
