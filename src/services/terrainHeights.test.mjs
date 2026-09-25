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
