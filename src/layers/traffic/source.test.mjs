import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  RoadRequestError,
  createTrafficSource,
  roadRequestError,
} from './source.js';
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

test('an Overpass refusal is named by status, and keeps the status beside the words', () => {
  // The panel prints this string verbatim, so the mapping is part of the
  // layer's contract with the reader, not an implementation detail.
  assert.equal(roadRequestError(429).message, 'Overpass rate-limited');
  assert.equal(roadRequestError(504).message, 'Overpass timed out');
  assert.equal(
    roadRequestError(406).message,
    'Overpass refused the road query (HTTP 406)',
  );
  assert.equal(
    roadRequestError(500).message,
    'Overpass refused the road query (HTTP 500)',
  );

  // An injected source may refuse without a readable code; a row must never
  // print "HTTP undefined" at a reader.
  for (const missing of [undefined, null, NaN, 'four-oh-six']) {
    const vague = roadRequestError(missing);
    assert.equal(vague.message, 'Overpass temporarily unavailable');
    assert.equal(vague.status, null, 'an unreadable code is absent, not zero');
  }

  const refused = roadRequestError(406);
  assert.ok(refused instanceof RoadRequestError);
  assert.ok(refused instanceof Error);
  assert.equal(refused.name, 'RoadRequestError');
  assert.equal(
    refused.status,
    406,
    'a caller must be able to branch on the code without parsing English',
  );
});
