import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTerrainHeights,
  DEFAULT_MAX_CACHE_ENTRIES,
} from './terrainHeights.js';

/**
 * A terrain source that always resolves, so these tests exercise the cache and
 * never the geoid-fallback path. Heights are derived from the coordinate so an
 * assertion can name the value it expects.
 */
function stubSource() {
  const batches = [];
  return {
    batches,
    async getHeights(chunk) {
      batches.push(chunk.map((item) => item.key));
      return chunk.map((item) => ({ ellipsoid: heightAt(item.lon) }));
    },
  };
}

/** Distinct 5-decimal coordinates along the equator: 0.001, 0.002, … */
const lonAt = (i) => i / 1000;
const heightAt = (lon) => 1000 + Math.round(lon * 1000);
const pointAt = (i) => ({ lat: 0, lon: lonAt(i) });

test('the default cache bound is exported so callers can reason about it', () => {
  assert.equal(DEFAULT_MAX_CACHE_ENTRIES, 20_000);
});

test('the in-memory cache stops growing once it reaches its entry bound', async () => {
  const terrain = createTerrainHeights({
    source: stubSource(),
    maxCacheEntries: 4,
  });

  // Six distinct coordinates through a cache that holds four.
  for (let i = 0; i < 6; i += 1) {
    await terrain.resolveEllipsoidalGround([pointAt(i)]);
  }

  // The two coldest are gone. Before the bound existed the cache kept every
  // coordinate a session ever resolved, so both of these still answered.
  assert.equal(terrain.cachedEllipsoidalGround(0, lonAt(0)), null);
  assert.equal(terrain.cachedEllipsoidalGround(0, lonAt(1)), null);

  // The four most recent are untouched — a bound, not a flush.
  for (let i = 2; i < 6; i += 1) {
    assert.equal(
      terrain.cachedEllipsoidalGround(0, lonAt(i)),
      heightAt(lonAt(i)),
      `coordinate ${i} stayed warm`,
    );
  }
});

test('a coordinate a consumer keeps reading outlives an equally old one it ignores', async () => {
  const terrain = createTerrainHeights({
    source: stubSource(),
    maxCacheEntries: 4,
  });
  for (let i = 0; i < 4; i += 1) {
    await terrain.resolveEllipsoidalGround([pointAt(i)]);
  }

  // Read coordinate 0 and ignore coordinate 1. They are otherwise the same age,
  // so insertion order alone could not tell them apart.
  assert.equal(
    terrain.cachedEllipsoidalGround(0, lonAt(0)),
    heightAt(lonAt(0)),
  );

  // Two fresh coordinates push the cache two entries past its bound.
  for (let i = 4; i < 6; i += 1) {
    await terrain.resolveEllipsoidalGround([pointAt(i)]);
  }

  assert.equal(
    terrain.cachedEllipsoidalGround(0, lonAt(0)),
    heightAt(lonAt(0)),
    'the cell being read survived eviction',
  );
  assert.equal(
    terrain.cachedEllipsoidalGround(0, lonAt(1)),
    null,
    'the same-age cell nobody read was evicted instead',
  );
});

test('a batch larger than the cache bound still reports every point it resolved', async () => {
  const terrain = createTerrainHeights({
    source: stubSource(),
    maxCacheEntries: 4,
  });
  const batch = Array.from({ length: 10 }, (_, i) => pointAt(i));

  const results = await terrain.resolveEllipsoidalGround(batch);

  // Eviction inside the call must not turn a point this batch resolved into an
  // unresolved one: the results are assembled from what the call produced, not
  // from whatever survived in the cache by the time it finished.
  assert.equal(results.length, batch.length);
  results.forEach((result, i) => {
    assert.equal(result.source, 'reearth', `point ${i} reported resolved`);
    assert.equal(result.ellipsoid, heightAt(lonAt(i)));
  });

  // The cache still honours the bound afterwards.
  const warm = batch.filter(
    (point) => terrain.cachedEllipsoidalGround(point.lat, point.lon) !== null,
  );
  assert.equal(warm.length, 4);
});

test('warm batch consumers retain their terrain cells ahead of unused cells', async () => {
  let calls = 0;
  const terrain = createTerrainHeights({
    maxCacheEntries: 2,
    source: {
      async getHeights(points) {
        calls++;
        return points.map((p) => ({ ellipsoid: 100 + p.lon }));
      },
    },
  });
  const p = (lon) => ({ lat: 0, lon });
  await terrain.resolveEllipsoidalGround([p(1)]);
  await terrain.resolveEllipsoidalGround([p(2)]);
  await terrain.resolveEllipsoidalGround([p(1)]);
  assert.equal(calls, 2);
  await terrain.resolveEllipsoidalGround([p(3)]);
  assert.equal(terrain.cachedEllipsoidalGround(0, 1), 101);
  assert.equal(terrain.cachedEllipsoidalGround(0, 2), null);
  assert.equal(calls, 3);
});

test('a batch still reports its warm points after its own fetches evict them', async () => {
  const terrain = createTerrainHeights({
    source: stubSource(),
    maxCacheEntries: 2,
  });
  await terrain.resolveEllipsoidalGround([pointAt(0)]);

  const results = await terrain.resolveEllipsoidalGround([
    pointAt(0),
    pointAt(1),
    pointAt(2),
  ]);

  results.forEach((result, i) => {
    assert.equal(result.source, 'reearth', `point ${i} reported resolved`);
    assert.equal(result.ellipsoid, heightAt(lonAt(i)));
  });
});

test('an out-of-range cache bound falls back to the default instead of disabling the cache', async () => {
  for (const maxCacheEntries of [0, -1, Number.NaN, undefined]) {
    const terrain = createTerrainHeights({
      source: stubSource(),
      maxCacheEntries,
    });
    await terrain.resolveEllipsoidalGround([pointAt(1)]);
    assert.equal(
      terrain.cachedEllipsoidalGround(0, lonAt(1)),
      heightAt(lonAt(1)),
      `maxCacheEntries=${String(maxCacheEntries)} kept a working cache`,
    );
  }
});

/** Counts Number.prototype.toFixed calls made while `run` executes. */
function countToFixed(run) {
  const original = Number.prototype.toFixed;
  let calls = 0;
  Number.prototype.toFixed = function (...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    run();
  } finally {
    Number.prototype.toFixed = original;
  }
  return calls;
}

test('a synchronous read finds exactly the entry its 5-decimal key names', async () => {
  // Stored coordinates, and for each the reads that must and must not reach it.
  // The expectation is the string key the cache has always used.
  const stored = [
    [0, 0.001],
    [51.47, -0.454],
    [-33.94611, 151.17722],
    [0.00001, 0.00002],
    [-0.00001, 0.00003],
    [89.99999, 179.99999],
    [-89.99999, -179.99999],
    [12.345675, 98.765435],
    [1e-7, 5],
    [-1e-7, 6],
    [7, -1e-7],
    [200.5, 361.25],
    [10, 500],
    [10, 499.999999],
  ];
  const key = (lat, lon) => `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const heights = new Map(
    stored.map(([lat, lon], i) => [key(lat, lon), 100 + i]),
  );
  const terrain = createTerrainHeights({
    source: {
      async getHeights(chunk) {
        return chunk.map((item) => ({ ellipsoid: heights.get(item.key) }));
      },
    },
  });
  await terrain.resolveEllipsoidalGround(
    stored.map(([lat, lon]) => ({ lat, lon })),
  );

  const probes = [];
  const nudges = [
    0, 1e-13, -1e-13, 1e-9, -1e-9, 4e-6, -4e-6, 4.9999e-6, 5e-6, -5e-6,
    5.0001e-6, 1e-5, -1e-5,
  ];
  for (const [lat, lon] of stored)
    for (const a of nudges)
      for (const b of [0, 4e-6, -5e-6])
        probes.push([lat + a, lon + b], [lat + b, lon + a]);
  probes.push([0, 0], [-0, 0.001], [0, -0], [NaN, 1], [1, Infinity], [1e21, 2]);

  let hits = 0;
  for (const [lat, lon] of probes) {
    const expected = heights.get(key(lat, lon)) ?? null;
    assert.equal(
      terrain.cachedEllipsoidalGround(lat, lon),
      expected,
      `plain read at ${lat}, ${lon}`,
    );
    assert.equal(
      terrain.cachedRealEllipsoidalGround(lat, lon),
      expected,
      `real read at ${lat}, ${lon}`,
    );
    if (expected !== null) hits += 1;
  }
  assert.ok(
    hits > 100 && hits < probes.length,
    `${hits} of ${probes.length} reads hit`,
  );
});

test('a synchronous read of an ordinary coordinate formats no numbers', async () => {
  const terrain = createTerrainHeights({ source: stubSource() });
  await terrain.resolveEllipsoidalGround([pointAt(1), pointAt(2)]);
  const calls = countToFixed(() => {
    assert.equal(
      terrain.cachedRealEllipsoidalGround(0, lonAt(1)),
      heightAt(lonAt(1)),
    );
    assert.equal(
      terrain.cachedEllipsoidalGround(0, lonAt(2)),
      heightAt(lonAt(2)),
    );
    // Misses are the common case: an aircraft over a cell nobody resolved.
    for (let i = 10; i < 1010; i += 1)
      assert.equal(terrain.cachedRealEllipsoidalGround(45.123, lonAt(i)), null);
  });
  // Before, every read built its key with two toFixed calls.
  assert.equal(calls, 0);
});

test('an entry read again and again is not rewritten on each read, and still outlives the rest', async () => {
  const terrain = createTerrainHeights({
    source: stubSource(),
    maxCacheEntries: 8,
  });
  for (let i = 0; i < 8; i += 1)
    await terrain.resolveEllipsoidalGround([pointAt(i)]);

  // Coordinate 0 is the coldest. Read it between stores, as a parked contact
  // would; the seven newer ones are never read.
  for (let i = 8; i < 15; i += 1) {
    for (let read = 0; read < 50; read += 1)
      assert.equal(
        terrain.cachedEllipsoidalGround(0, lonAt(0)),
        heightAt(lonAt(0)),
      );
    await terrain.resolveEllipsoidalGround([pointAt(i)]);
  }
  assert.equal(
    terrain.cachedEllipsoidalGround(0, lonAt(0)),
    heightAt(lonAt(0)),
  );
  for (let i = 1; i < 8; i += 1)
    assert.equal(
      terrain.cachedEllipsoidalGround(0, lonAt(i)),
      null,
      `unread coordinate ${i} was evicted`,
    );
});

test('an evicted coordinate is gone from the synchronous read too', async () => {
  const terrain = createTerrainHeights({
    source: stubSource(),
    maxCacheEntries: 2,
  });
  for (let i = 0; i < 5; i += 1)
    await terrain.resolveEllipsoidalGround([pointAt(i)]);
  for (let i = 0; i < 3; i += 1)
    assert.equal(terrain.cachedRealEllipsoidalGround(0, lonAt(i)), null);
  for (let i = 3; i < 5; i += 1)
    assert.equal(
      terrain.cachedRealEllipsoidalGround(0, lonAt(i)),
      heightAt(lonAt(i)),
    );
});
