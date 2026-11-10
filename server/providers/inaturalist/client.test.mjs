import test from 'node:test';
import assert from 'node:assert/strict';
import { createInatClient } from './client.js';
import { syntheticGrid } from './grid.fixture.mjs';

const NOW = Date.parse('2026-11-04T18:05:00Z');
const observation = (id, time) => ({
  id,
  geojson: { coordinates: [-122.3, 47.6] },
  quality_grade: 'research',
  time_observed_at: time,
  observed_on: time.slice(0, 10),
  // Upload age does not determine whether an observation is recent.
  created_at: '2026-11-04T18:00:00Z',
  taxon: { name: 'Synthetic taxon', iconic_taxon_name: 'Aves' },
});

function clientFor(results) {
  return createInatClient({
    now: () => NOW,
    cacheDir: null,
    queueOptions: { intervalMs: 0 },
    warn() {},
    fetchImpl: async () =>
      Response.json({ results, total_results: results.length }),
  });
}

test('iNaturalist drops ancient and boundary-expired observations uploaded today', async () => {
  const client = clientFor([
    observation(1, '2010-11-04T18:00:00Z'),
    observation(2, '2026-11-02T18:04:59Z'),
    observation(3, '2026-11-02T18:05:00Z'),
  ]);
  const result = await client.getObservations({
    scope: 'global',
    taxa: 'all',
    observedD1: '2026-11-02',
  });
  assert.deepEqual(
    result.rows.map((row) => row.stableId),
    ['inat:3'],
  );
});

test('a valid date-filtered page can be empty after the exact recency cutoff', async () => {
  const client = clientFor([observation(1, '2026-11-02T06:00:00Z')]);
  const result = await client.getObservations({
    scope: 'global',
    taxa: 'all',
    observedD1: '2026-11-02',
  });
  assert.deepEqual(result.rows, []);
  assert.equal(result.totalResults, 1);
});

const params = {
  scope: 'view',
  box: { south: 47, west: -123, north: 48, east: -122 },
  taxa: 'all',
  observedD1: '2026-11-02',
};

test('observations and tiles share pacing, and observation priority wins a cold burst', async () => {
  let at = 0;
  const calls = [];
  const client = createInatClient({
    cacheDir: null,
    now: () => NOW + at,
    queueOptions: {
      now: () => at,
      wait: async (ms) => {
        at += ms;
      },
    },
    fetchImpl: async (url) => {
      const isGrid = new URL(url).pathname.includes('/grid/');
      calls.push([isGrid ? 'grid' : 'observations', at]);
      return Response.json(
        isGrid ? syntheticGrid() : { results: [], total_results: 0 },
      );
    },
  });
  const tiles = Array.from({ length: 3 }, (_, x) =>
    client.getGrid({ ...params, z: 2, x, y: 1 }),
  );
  await Promise.all([...tiles, client.getObservations(params)]);
  assert.deepEqual(calls, [
    ['observations', 0],
    ['grid', 0],
    ['grid', 0],
    ['grid', 0],
  ]);
  assert.equal(client.budgetState().count, 4);
});

test('upstream status and safe failure reasons are logged without upstream messages or URLs', async () => {
  for (const [response, expected] of [
    [
      () =>
        new Response('request-secret', {
          status: 503,
          statusText: 'request-secret',
        }),
      /status=503 reason=http/,
    ],
    [
      () => Promise.reject(new DOMException('request-secret', 'TimeoutError')),
      /status=none reason=timeout/,
    ],
    [
      () => Response.json({ unexpected: 'request-secret' }),
      /status=200 reason=invalid-payload/,
    ],
  ]) {
    const warnings = [];
    const client = createInatClient({
      cacheDir: null,
      now: () => NOW,
      queueOptions: { intervalMs: 0 },
      warn: (message) => warnings.push(message),
      fetchImpl: response,
    });
    await assert.rejects(client.getObservations(params), { status: 502 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], expected);
    assert.doesNotMatch(warnings[0], /request-secret|https?:|swlat|d1=/);
  }
});

test('a dispatched abort is diagnosed, spends only its attempt, and leaves the next request healthy', async () => {
  const warnings = [];
  const controller = new AbortController();
  let started;
  const didStart = new Promise((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const client = createInatClient({
    cacheDir: null,
    now: () => NOW,
    queueOptions: { intervalMs: 0 },
    warn: (message) => warnings.push(message),
    fetchImpl: async (url, { signal }) => {
      calls += 1;
      if (calls > 1) return Response.json({ results: [], total_results: 0 });
      started();
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const pending = client.getObservations(params, { signal: controller.signal });
  const failed = assert.rejects(pending, { name: 'AbortError' });
  await didStart;
  controller.abort();
  await failed;
  assert.match(warnings[0], /resource=observations status=none reason=abort/);
  await client.getObservations(params);
  assert.equal(calls, 2);
});
