import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLocalCache,
  readLocalCache,
  setLocalCacheStorage,
  trimLocalCache,
  writeLocalCache,
} from './localCache.js';

/** A Map-backed localStorage good enough to exercise real code paths. */
function stubStorage() {
  const map = new Map();
  let pendingFailures = 0;
  const realSetItem = (k, v) => { map.set(k, String(v)); };
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => {
      if (pendingFailures > 0) {
        pendingFailures -= 1;
        throw new DOMException('quota', 'QuotaExceededError');
      }
      realSetItem(k, v);
    },
    /** Test hook: make the next N setItem calls throw (quota exhaustion). */
    failNextWrite: (times = 1) => { pendingFailures += times; },
  };
}

test.beforeEach(() => setLocalCacheStorage(stubStorage()));
test.afterEach(() => setLocalCacheStorage(null));

test('a write is readable back until its TTL expires', () => {
  assert.equal(writeLocalCache('k', { a: 1 }, { ttlMs: 1000, nowMs: 500 }), true);
  assert.deepEqual(readLocalCache('k', { nowMs: 1000 }), { hit: true, value: { a: 1 } });

  const expired = readLocalCache('k', { nowMs: 1500 });
  assert.equal(expired.hit, false);
  assert.equal(expired.value, null, 'an expired entry is a miss, never served');
  // And it was removed, not left to rot in the store.
  assert.equal(readLocalCache('k', { nowMs: 1600 }).hit, false);
});

test('a missing or disabled store degrades to a miss, never throws', () => {
  setLocalCacheStorage(null);
  assert.equal(writeLocalCache('k', { a: 1 }, { ttlMs: 1000 }), false);
  assert.deepEqual(readLocalCache('k'), { hit: false, value: null });
});

test('a write without a positive TTL is refused — no unbounded commitments', () => {
  for (const ttl of [0, -5, Number.NaN, undefined]) {
    assert.equal(writeLocalCache('k', { a: 1 }, { ttlMs: ttl }), false, `ttl=${ttl}`);
  }
  assert.equal(writeLocalCache('k', null, { ttlMs: 1000 }), false, 'null is not a cacheable payload');
  assert.equal(readLocalCache('k').hit, false);
});

test('a corrupted entry is dropped and reported as a miss', () => {
  const store = stubStorage();
  setLocalCacheStorage(store);
  store.setItem('gev:cache:bad', '{not json');
  assert.equal(readLocalCache('bad').hit, false);
  assert.equal(store.getItem('gev:cache:bad'), null, 'the corrupt entry does not survive');
});

test('a quota error evicts cold entries and retries once', () => {
  const store = stubStorage();
  setLocalCacheStorage(store);
  // Seed entries that were never read this session (coldest possible).
  for (let i = 0; i < 10; i += 1) {
    store.setItem(`gev:cache:old-${i}`, JSON.stringify({ c: { i }, w: 0, t: 1e12 }));
  }
  store.failNextWrite();
  assert.equal(writeLocalCache('fresh', { hot: true }, { ttlMs: 1000, nowMs: 42 }), true,
    'the retry after eviction succeeds');
  assert.deepEqual(readLocalCache('fresh', { nowMs: 50 }).value, { hot: true });
  const survivors = [];
  for (let i = 0; i < store.length; i += 1) survivors.push(store.key(i));
  assert.ok(survivors.length < 10, 'some cold entries were evicted to make room');
  assert.ok(survivors.includes('gev:cache:fresh'), 'the new entry survived');
});

test('an uncooperative store fails the write after the single retry', () => {
  const store = stubStorage();
  setLocalCacheStorage(store);
  // Fail EVERY write: the retry after the (no-op) eviction also throws.
  store.failNextWrite();
  store.failNextWrite();
  assert.equal(writeLocalCache('k', { a: 1 }, { ttlMs: 1000 }), false,
    'nothing evictable + failing writes = an honest false');
});

test('trimLocalCache keeps the most-recently-read entries', () => {
  const store = stubStorage();
  setLocalCacheStorage(store);
  for (let i = 0; i < 5; i += 1) {
    store.setItem(`gev:cache:e${i}`, JSON.stringify({ c: { i }, w: Date.now(), t: 1e12 }));
  }
  readLocalCache('e3'); // touches e3 only — everything else is colder
  trimLocalCache(2);
  const survivors = new Set();
  for (let i = 0; i < store.length; i += 1) survivors.add(store.key(i));
  assert.ok(survivors.size <= 2, `trimmed to the cap, got ${survivors.size}`);
  assert.ok([...survivors].some((k) => k.endsWith('e3')),
    'the entry read this session must survive');
  assert.ok(survivors.size === 2, 'and exactly the cap remains');
});

test('clearLocalCache removes only the app namespace', () => {
  const store = stubStorage();
  setLocalCacheStorage(store);
  store.setItem('gev:cache:mine', JSON.stringify({ c: {}, w: 0, t: 1e12 }));
  store.setItem('other:key', 'keep me');
  clearLocalCache();
  assert.equal(store.getItem('gev:cache:mine'), null);
  assert.equal(store.getItem('other:key'), 'keep me');
});
