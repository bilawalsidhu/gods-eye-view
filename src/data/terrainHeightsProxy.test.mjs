// Terrain proxy cache/retry mechanics. All dependencies are injected; no real
// network, disk, or Vite server is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchTerrainChunkWithRetry,
  parseTerrainPoints,
  resolveTerrainHeightRequest,
  serializeTerrainCache,
  terrainPointKey,
} from './terrainHeightsProxy.js';

function result(id, ellipsoid) {
  return { id, ellipsoid, elevation: ellipsoid - 10, geoid: 10 };
}

test('per-point cache reconstruction preserves exact request order with mixed hits/misses and duplicates', async () => {
  const now = 50_000;
  const cache = new Map([
    [terrainPointKey([10, 1]), { at: now, result: result('cached-a', 101) }],
    [terrainPointKey([30, 3]), { at: now, result: result('cached-c', 303) }],
  ]);
  const points = [[30, 3], [20, 2], [10, 1], [40, 4], [20, 2]];
  let fetchedPoints = null;

  const response = await resolveTerrainHeightRequest({
    points,
    cache,
    ttlMs: 10_000,
    now: () => now,
    fetchMissing: async (missing) => {
      fetchedPoints = missing;
      return [result('fresh-b', 202), result('fresh-d', 404)];
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(fetchedPoints, [[20, 2], [40, 4]], 'only unique cache misses go upstream');
  assert.deepEqual(
    response.body.results.map((item) => item.id),
    ['cached-c', 'fresh-b', 'cached-a', 'fresh-d', 'fresh-b'],
    'each output position must map back to its own input point'
  );
});

test('429 retry honors Retry-After before the next attempt', async () => {
  let clock = 1_000_000;
  let attempts = 0;
  const sleeps = [];
  const results = await fetchTerrainChunkWithRetry([[12.345678, 45.678912]], {
    now: () => clock,
    random: () => 0.5,
    makeSignal: () => undefined,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '3' : null },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [result('recovered', 88)] }),
      };
    },
  });

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [3000]);
  assert.equal(results[0].id, 'recovered');
});

test('permanently failing upstream exhausts retries and returns 502 without fake results', async () => {
  let clock = 2_000_000;
  let attempts = 0;
  const response = await resolveTerrainHeightRequest({
    points: [[-97.7431, 30.2672]],
    cache: new Map(),
    ttlMs: 10_000,
    now: () => clock,
    fetchMissing: (missing) => fetchTerrainChunkWithRetry(missing, {
      now: () => clock,
      random: () => 0.5,
      makeSignal: () => undefined,
      sleep: async (ms) => { clock += ms; },
      fetchImpl: async () => {
        attempts += 1;
        return { ok: false, status: 503, headers: { get: () => null } };
      },
    }),
  });

  assert.equal(attempts, 4, 'one initial attempt plus three retries');
  assert.equal(response.status, 502);
  assert.equal('results' in response.body, false, 'failure body must not fabricate positional heights');
});

test('stale per-point entries serve through a failed refresh only when every point is real', async () => {
  const cache = new Map([
    [terrainPointKey([1, 1]), { at: 0, result: result('stale-a', 11) }],
    [terrainPointKey([2, 2]), { at: 0, result: result('stale-b', 22) }],
  ]);
  const response = await resolveTerrainHeightRequest({
    points: [[2, 2], [1, 1]],
    cache,
    ttlMs: 100,
    now: () => 1000,
    fetchMissing: async () => { throw new Error('offline'); },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.results.map((item) => item.id), ['stale-b', 'stale-a']);
});

test('out-of-range coordinates are rejected before they can be cached or sent upstream', () => {
  assert.equal(parseTerrainPoints('181,0'), null);
  assert.equal(parseTerrainPoints('0,91'), null);
  assert.equal(parseTerrainPoints('-180.00001,0'), null);
  assert.equal(parseTerrainPoints('0,-90.00001'), null);
  assert.equal(parseTerrainPoints('10,20;181,0'), null, 'one bad pair rejects the batch');
  assert.deepEqual(parseTerrainPoints('180,90;-180,-90'), [[180, 90], [-180, -90]]);
  assert.deepEqual(parseTerrainPoints('0,0'), [[0, 0]]);
});

test('the per-point cache stays within its cap and never evicts a point refreshed by the request', async () => {
  const cache = new Map();
  for (let i = 0; i < 5; i += 1) cache.set(`old-${i}`, { at: i, result: result(`old-${i}`, i) });
  const fetched = [result('new-a', 100), result('new-b', 200)];
  const response = await resolveTerrainHeightRequest({
    points: [[10, 10], [20, 20]],
    cache,
    fetchMissing: async () => fetched,
    ttlMs: 1000,
    now: () => 10_000,
    maxCacheEntries: 4,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.results.map((item) => item.id), ['new-a', 'new-b']);
  assert.equal(cache.size, 4);
  assert.deepEqual([...cache.keys()], [
    'old-3', 'old-4',
    terrainPointKey([10, 10]), terrainPointKey([20, 20]),
  ]);
});

test('disk serialization drops the oldest points to stay within the byte cap', () => {
  const cache = new Map();
  for (let i = 0; i < 200; i += 1) {
    cache.set(`key-${i}`, { at: i, result: { ...result(`id-${i}`, i), padding: 'x'.repeat(64) } });
  }
  const unbounded = JSON.parse(serializeTerrainCache(cache));
  assert.equal(Object.keys(unbounded.points).length, 200);

  const maxBytes = 4096;
  const bounded = serializeTerrainCache(cache, maxBytes);
  assert.ok(Buffer.byteLength(bounded, 'utf8') <= maxBytes);
  const parsed = JSON.parse(bounded);
  assert.equal(parsed.version, 2);
  assert.ok(Object.keys(parsed.points).length < 200);
  assert.ok(parsed.points['key-199'], 'the newest point survives');
  assert.equal(parsed.points['key-0'], undefined, 'the oldest point is dropped first');
});
