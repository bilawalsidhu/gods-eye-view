import test from 'node:test';
import assert from 'node:assert/strict';

import { readCachedTle, writeCachedTle } from './tleCache.js';
import { readLocalCache, setLocalCacheStorage } from './localCache.js';

function stubStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

test.beforeEach(() => setLocalCacheStorage(stubStorage()));
test.afterEach(() => setLocalCacheStorage(null));

const TLE = ['ISS (ZARYA)', '1 25544U 98067A   24180.51782528  .00016717  00000+0  30777-3 0  9993', '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537'].join('\n');

test('a cached group round-trips as plain text in its own namespace slot', () => {
  assert.equal(writeCachedTle('stations', TLE), true);
  assert.equal(readCachedTle('stations'), TLE);
  assert.equal(readLocalCache('tle:stations').hit, true);
});

test('an oversized catalog is refused — megabytes of text must not churn the quota', () => {
  const huge = 'x'.repeat(128_001);
  assert.equal(writeCachedTle('active', huge), false);
  assert.equal(readCachedTle('active'), null, 'nothing was persisted');
  assert.equal(writeCachedTle('active', TLE), true, 'a normal catalog still fits');
});

test('a miss is a null, never an empty string that would parse as zero TLEs', () => {
  assert.equal(readCachedTle('never-heard-of-it'), null);
  assert.equal(readCachedTle(''), null);
});
