import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TILESET_CACHE_MB,
  DEFAULT_TILESET_OVERFLOW_MB,
  MAX_TILESET_CACHE_MB,
  resolveTilesetCacheOptions,
  applyTilesetCachePolicy,
} from './tilesetCachePolicy.js';

const MIB = 1024 * 1024;

test('default budget is 384 MiB cache / 128 MiB overflow — ¼ of the stock 1536/1024', () => {
  const policy = resolveTilesetCacheOptions({ search: '' });
  assert.equal(policy.cacheMiB, DEFAULT_TILESET_CACHE_MB);
  assert.equal(policy.overflowMiB, DEFAULT_TILESET_OVERFLOW_MB);
  assert.equal(policy.cacheBytes, 384 * MIB);
  assert.equal(policy.maximumCacheOverflowBytes, 128 * MIB);
});

test('?tileCacheMB=N overrides the cache; overflow follows at the 3:1 ratio', () => {
  const policy = resolveTilesetCacheOptions({ search: '?tileCacheMB=768' });
  assert.equal(policy.cacheMiB, 768);
  assert.equal(policy.overflowMiB, 256);
  assert.equal(policy.cacheBytes, 768 * MIB);
  assert.equal(policy.maximumCacheOverflowBytes, 256 * MIB);
});

test('?tileCacheOverflowMB=N pins the overflow independently', () => {
  const policy = resolveTilesetCacheOptions({ search: '?tileCacheMB=900&tileCacheOverflowMB=64' });
  assert.equal(policy.cacheMiB, 900);
  assert.equal(policy.overflowMiB, 64);
});

test('overrides are clamped: sub-1 falls back to default, huge caps at 4096', () => {
  assert.equal(resolveTilesetCacheOptions({ search: '?tileCacheMB=0' }).cacheMiB, DEFAULT_TILESET_CACHE_MB);
  assert.equal(resolveTilesetCacheOptions({ search: '?tileCacheMB=-5' }).cacheMiB, DEFAULT_TILESET_CACHE_MB);
  assert.equal(resolveTilesetCacheOptions({ search: '?tileCacheMB=NaN' }).cacheMiB, DEFAULT_TILESET_CACHE_MB);
  assert.equal(resolveTilesetCacheOptions({ search: '?tileCacheMB=999999' }).cacheMiB, MAX_TILESET_CACHE_MB);
  assert.equal(resolveTilesetCacheOptions({ search: '?tileCacheOverflowMB=99999999' }).overflowMiB, MAX_TILESET_CACHE_MB);
});

test('applyTilesetCachePolicy writes both knobs onto the tileset', () => {
  const tileset = {};
  const policy = { cacheBytes: MIB, maximumCacheOverflowBytes: 2 * MIB };
  const applied = applyTilesetCachePolicy(tileset, policy);
  assert.equal(applied, policy);
  assert.equal(tileset.cacheBytes, MIB);
  assert.equal(tileset.maximumCacheOverflowBytes, 2 * MIB);
});

test('applyTilesetCachePolicy is a safe no-op on the fallback-globe path (no tileset)', () => {
  assert.equal(applyTilesetCachePolicy(null), null);
  assert.equal(applyTilesetCachePolicy(undefined), null);
});
