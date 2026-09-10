import test from 'node:test';
import assert from 'node:assert/strict';

import { reverseGeocodePlace } from './openzenith.js';
import { setLocalCacheStorage } from './localCache.js';

/** Map-backed localStorage stub, same shape as localCache.test.mjs uses. */
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

const PLACE_BODY = JSON.stringify({
  place: {
    display_name: '7024, Vail Ridge Street, Colorado Crossing, Austin, Travis County, Texas, 78744, United States',
    name: '7024',
    type: 'yes',
    address: {
      house_number: '7024', road: 'Vail Ridge Street', city: 'Austin',
      county: 'Travis County', state: 'Texas', postcode: '78744', country: 'United States',
    },
    osm_id: 824608455, osm_type: 'way',
  },
  location: { lat: 30.2, lon: -97.7 },
});

test.beforeEach(() => setLocalCacheStorage(stubStorage()));
test.afterEach(() => setLocalCacheStorage(null));

test('a place is resolved through the proxy and shaped to the readout fields', async (t) => {
  let requested = null;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    requested = String(url);
    return { ok: true, status: 200, json: async () => JSON.parse(PLACE_BODY) };
  };
  const place = await reverseGeocodePlace(30.20123, -97.70456);
  assert.equal(place.label, 'Austin, Texas');
  assert.match(requested, /^\/api\/openzenith\/reverse-geocode\?lat=30\.201&lon=-97\.705$/,
    'the cell key rounds to ~100 m so repeated selections hit one cache entry');
});

test('a repeat lookup is answered from the browser cache, not the network', async (t) => {
  let proxyHits = 0;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => {
    proxyHits += 1;
    return { ok: true, status: 200, json: async () => JSON.parse(PLACE_BODY) };
  };
  await reverseGeocodePlace(30.2, -97.7);
  const again = await reverseGeocodePlace(30.2, -97.7);
  assert.equal(again.label, 'Austin, Texas');
  assert.equal(proxyHits, 1, 'the persisted entry survives within and across sessions');
});

test('an addressless cell (open water) is cached as a negative, not re-fetched', async (t) => {
  let proxyHits = 0;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => {
    proxyHits += 1;
    return { ok: true, status: 200, json: async () => ({ place: { display_name: '', address: {} } }) };
  };
  assert.equal(await reverseGeocodePlace(25.0, -71.0), null);
  assert.equal(await reverseGeocodePlace(25.0, -71.0), null);
  assert.equal(proxyHits, 1, 'the negative result costs one lookup, ever, for the TTL');
});

test('a non-numeric coordinate never reaches the proxy', async (t) => {
  let called = false;
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  assert.equal(await reverseGeocodePlace(NaN, -97.7), null);
  assert.equal(await reverseGeocodePlace(30.2, undefined), null);
  assert.equal(called, false);
});

test('a proxy failure is a silent null — garnish never surfaces errors', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  assert.equal(await reverseGeocodePlace(30.2, -97.7), null);
});
