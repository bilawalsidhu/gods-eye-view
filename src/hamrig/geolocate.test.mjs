import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callsignKey, createGeolocator, locFromCty } from './geolocate.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const DH5DAX = fixture('hamrig-callsign-db-dh5dax.json');

const CTY_TABLE = {
  DE: { entity: 'Fed. Rep. of Germany', primaryPrefix: 'DL', cq: 14, itu: 28, continent: 'EU', lat: 51, lon: 10, utcOffset: 1, matchType: 'prefix', waeOnly: false, precision: 'entity' },
  US6: { entity: 'United States', primaryPrefix: 'K', cq: 3, itu: 6, continent: 'NA', lat: 37, lon: -120, utcOffset: -5, matchType: 'prefix', waeOnly: false, precision: 'area' },
  IT: { entity: 'Italy', primaryPrefix: 'I', cq: 15, itu: 28, continent: 'EU', lat: 42.82, lon: 12.58, utcOffset: 1, matchType: 'prefix', waeOnly: false, precision: 'entity' },
};

function fakeCty(overrides = {}) {
  const calls = [];
  return {
    calls,
    resolve(call) {
      calls.push(call);
      if (call in overrides) return overrides[call];
      if (/^DL|^DH|^DJ|^DK/.test(call)) return CTY_TABLE.DE;
      if (/^W6|^K6|^N6/.test(call)) return CTY_TABLE.US6;
      if (/^IK|^IZ|^I[0-9]/.test(call)) return CTY_TABLE.IT;
      return null;
    },
  };
}

/**
 * Fake HamRig client. `db` maps CALL → callsign-db payload (or a function);
 * `located` maps CALL → locate-calls row. Records every call.
 */
function fakeClient({ db = {}, located = {}, canAuthenticate = false, baseUrl = 'https://test.hamrig.com', delayGet = null } = {}) {
  const calls = [];
  return {
    calls,
    canAuthenticate,
    status: () => ({ baseUrl, configured: true, canAuthenticate, authenticated: false, tokenExpiresAt: null }),
    async get(p, opts = {}) {
      calls.push({ method: 'GET', path: p, opts });
      if (delayGet) await delayGet();
      const call = decodeURIComponent(p.replace('/api/public/callsign-db/', ''));
      const value = typeof db[call] === 'function' ? db[call]() : db[call];
      if (value instanceof Error) throw value;
      if (value === undefined) return { status: 200, json: { success: true, callsign: { callsign: call, first_name: 'NOT_FOUND', last_name: 'NOT_FOUND', address: 'NOT_FOUND', city: 'NOT_FOUND', state: 'NOT_FOUND', zip: 'NOT_FOUND', country: 'NOT_FOUND', grid_square: 'NOT_FOUND', license_class: 'NOT_FOUND', source: 'hamdb' }, hamrig_user: { is_hamrig_user: false }, source: 'hamdb' }, text: '' };
      if (typeof value === 'object' && 'status' in value && !('success' in value)) return value;
      return { status: 200, json: value, text: JSON.stringify(value) };
    },
    async post(p, body, opts = {}) {
      calls.push({ method: 'POST', path: p, body, opts });
      if (p !== '/api/map/data/locate-calls') return { status: 404, json: { error: 'not found' }, text: '' };
      const out = {};
      for (const c of body.calls) if (located[c]) out[c] = located[c];
      return { status: 200, json: { success: true, located: out, count: Object.keys(out).length }, text: '' };
    },
  };
}

function clock(start = Date.UTC(2026, 8, 12, 15, 0, 0)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

const quiet = { warn() {}, info() {} };

test('callsignKey applies cleanSpotter semantics', () => {
  assert.equal(callsignKey('DL8LAS-#'), 'DL8LAS');
  assert.equal(callsignKey('w3lpl-2'), 'W3LPL');
  assert.equal(callsignKey(' DH5DAX: '), 'DH5DAX');
  assert.equal(callsignKey('S79/DL2SBY'), 'S79/DL2SBY');
  assert.equal(callsignKey(''), null);
  assert.equal(callsignKey(null), null);
  assert.equal(callsignKey('DL1 ABC'), null);
  assert.equal(callsignKey('-#'), null);
});

test('locFromCty maps area/entity precision and drops bad coordinates', () => {
  assert.deepEqual(locFromCty(CTY_TABLE.US6), { lat: 37, lon: -120, precision: 'area', entity: 'United States', continent: 'NA', adif: null, cq: 3 });
  assert.equal(locFromCty({ ...CTY_TABLE.DE, lat: null }), null);
  assert.equal(locFromCty(null), null);
});

test('locateEntity is synchronous, offline and cleans spotter suffixes', () => {
  const cty = fakeCty();
  const client = fakeClient();
  const geo = createGeolocator({ cty, client, log: quiet });
  const loc = geo.locateEntity('DL8LAS-#');
  assert.deepEqual(loc, { lat: 51, lon: 10, precision: 'entity', entity: 'Fed. Rep. of Germany', continent: 'EU', adif: null, cq: 14 });
  assert.deepEqual(cty.calls, ['DL8LAS']);
  assert.equal(geo.locateEntity('W6ABC').precision, 'area');
  assert.equal(geo.locateEntity('ZZZ9ZZ'), null);
  assert.equal(geo.locateEntity(''), null);
  assert.equal(client.calls.length, 0, 'never hits the network');
});

test('locateEntity survives a throwing or missing cty resolver', () => {
  const geo = createGeolocator({ cty: { resolve() { throw new Error('boom'); } }, client: null, log: quiet });
  assert.equal(geo.locateEntity('DL1ABC'), null);
  const none = createGeolocator({ cty: null, client: null, log: quiet });
  assert.equal(none.locateEntity('DL1ABC'), null);
});

test('locatePrecise: exact callsign-db row → exact Loc, cached, station available', async () => {
  const now = clock();
  const client = fakeClient({ db: { DH5DAX } });
  const geo = createGeolocator({ cty: fakeCty(), client, now, log: quiet });
  const loc = await geo.locatePrecise('dh5dax');
  assert.deepEqual(loc, { lat: 52.186667, lon: 7.04, precision: 'exact', entity: 'Germany', continent: 'EU', adif: 230, cq: 14 });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, '/api/public/callsign-db/DH5DAX');
  assert.equal(client.calls[0].opts.auth ?? false, false, 'callsign-db is public');

  const again = await geo.locatePrecise('DH5DAX');
  assert.deepEqual(again, loc);
  assert.equal(client.calls.length, 1, 'served from cache');

  const station = await geo.stationFor('DH5DAX');
  assert.equal(client.calls.length, 1, 'station shares the cache entry');
  assert.equal(station.callsign, 'DH5DAX');
  assert.equal(station.name, 'Michael Beck');
  assert.equal(station.precision, 'exact');
  const serialized = JSON.stringify(station);
  for (const key of ['email', 'addr1', 'addr2', 'zip', 'county', 'bio', 'data_sources', 'trustee']) assert.ok(!serialized.includes(`"${key}"`), key);
  assert.ok(!serialized.includes('Hoher Weg'));
  assert.equal(station.hamrigUser.avatarUrl, 'https://test.hamrig.com/uploads/avatars/avatar_1_1768165119.jpg', 'baseUrl from client.status()');

  const stats = geo.stats();
  assert.equal(stats.cacheSize, 1);
  assert.equal(stats.lookups, 1);
  assert.equal(stats.hits, 2);
  assert.equal(stats.negatives, 0);

  now.advance(24 * 60 * 60 * 1000 + 1);
  await geo.locatePrecise('DH5DAX');
  assert.equal(client.calls.length, 2, 're-fetched after the precise TTL');
});

test('locatePrecise: grid-only row → grid centre; encodes slashes in the path', async () => {
  const db = {
    'S79/DL2SBY': { success: true, callsign: { callsign: 'S79/DL2SBY', first_name: 'Test', last_name: 'Op', grid_square: 'LI75', latitude: null, longitude: null, country: 'Seychelles', continent: 'AF', dxcc_code: 379, cq_zone: 39 }, hamrig_user: { is_hamrig_user: false }, source: 'callsign_database' },
  };
  const client = fakeClient({ db });
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet });
  const loc = await geo.locatePrecise('S79/DL2SBY');
  assert.equal(client.calls[0].path, '/api/public/callsign-db/S79%2FDL2SBY');
  assert.equal(loc.precision, 'grid');
  assert.ok(Math.abs(loc.lat - (-4.5)) < 1e-9, `lat ${loc.lat}`);
  assert.ok(Math.abs(loc.lon - 55) < 1e-9, `lon ${loc.lon}`);
  assert.equal(loc.entity, 'Seychelles');
  assert.equal(loc.adif, 379);
  assert.equal(loc.cq, 39);
});

test('locatePrecise: NOT_FOUND row falls back to cty, negative-cached for negativeTtlMs', async () => {
  const now = clock();
  const client = fakeClient();
  const geo = createGeolocator({ cty: fakeCty(), client, now, log: quiet, negativeTtlMs: 60 * 60 * 1000 });
  const loc = await geo.locatePrecise('DL9ZQX');
  assert.deepEqual(loc, { lat: 51, lon: 10, precision: 'entity', entity: 'Fed. Rep. of Germany', continent: 'EU', adif: null, cq: 14 });
  assert.equal(client.calls.length, 1);
  assert.ok(client.calls.every((c) => c.method === 'GET'), 'no locate-calls without credentials');

  const station = await geo.stationFor('DL9ZQX');
  assert.ok(station, 'a cty position is enough for a station card');
  assert.equal(station.callsign, 'DL9ZQX');
  assert.equal(station.name, null);
  assert.equal(station.precision, 'entity');
  assert.deepEqual(station.sources, ['hamdb', 'cty.dat']);
  assert.equal(client.calls.length, 1);

  now.advance(30 * 60 * 1000);
  await geo.locatePrecise('DL9ZQX');
  assert.equal(client.calls.length, 1, 'negative cache holds for 30 min');
  now.advance(31 * 60 * 1000);
  await geo.locatePrecise('DL9ZQX');
  assert.equal(client.calls.length, 2, 'negative entry expired after negativeTtlMs');
  assert.equal(geo.stats().negatives, 2);
});

test('locatePrecise: unknown everywhere → null, station null', async () => {
  const client = fakeClient();
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet });
  assert.equal(await geo.locatePrecise('ZZ9ZZZ'), null);
  assert.equal(await geo.stationFor('ZZ9ZZZ'), null);
  assert.equal(await geo.locatePrecise('   '), null);
  assert.equal(await geo.stationFor(null), null);
});

test('locatePrecise: authenticated → locate-calls prefix-row coordinates beat the cty centroid', async () => {
  const client = fakeClient({
    canAuthenticate: true,
    located: { IK6MNB: { adif: 248, entity: 'Italy', lat: 43.5, lon: 13.5 } },
  });
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet });
  const loc = await geo.locatePrecise('IK6MNB');
  assert.deepEqual(loc, { lat: 43.5, lon: 13.5, precision: 'entity', entity: 'Italy', continent: 'EU', adif: 248, cq: 15 });
  const post = client.calls.find((c) => c.method === 'POST');
  assert.ok(post);
  assert.equal(post.path, '/api/map/data/locate-calls');
  assert.deepEqual(post.body, { calls: ['IK6MNB'] });
  assert.equal(post.opts.auth, true);
  const station = await geo.stationFor('IK6MNB');
  assert.equal(station.lat, 43.5, 'station position upgraded to the prefix row');
  assert.equal(station.precision, 'entity');
  assert.equal(geo.stats().locateCalls, 1);
});

test('locatePrecise: authenticated but locate-calls misses → cty; exact rows skip locate-calls', async () => {
  const client = fakeClient({ canAuthenticate: true, db: { DH5DAX } });
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet });
  const exact = await geo.locatePrecise('DH5DAX');
  assert.equal(exact.precision, 'exact');
  assert.equal(client.calls.filter((c) => c.method === 'POST').length, 0, 'no locate-calls for an exact hit');
  const fallback = await geo.locatePrecise('DL9ZQX');
  assert.equal(fallback.precision, 'entity');
  assert.equal(fallback.lat, 51);
  assert.equal(client.calls.filter((c) => c.method === 'POST').length, 1);
});

test('locatePrecise: transport errors fall back to cty and are cached briefly', async () => {
  const now = clock();
  const client = fakeClient({ db: { DL1ABC: new Error('socket hang up') } });
  const geo = createGeolocator({ cty: fakeCty(), client, now, log: quiet, negativeTtlMs: 60 * 60 * 1000 });
  const loc = await geo.locatePrecise('DL1ABC');
  assert.equal(loc.precision, 'entity');
  assert.equal(client.calls.length, 1);
  await geo.locatePrecise('DL1ABC');
  assert.equal(client.calls.length, 1, 'cached');
  now.advance(5 * 60 * 1000 + 1);
  await geo.locatePrecise('DL1ABC');
  assert.equal(client.calls.length, 2, 'transient entries expire after 5 min, not negativeTtlMs');
  assert.equal(geo.stats().errors, 2, 'both upstream attempts failed');
});

test('locatePrecise: HTTP 404/500 → cty fallback without throwing', async () => {
  const client = fakeClient({ db: { DL1ABC: { status: 404, json: { error: 'not found' }, text: '' }, DL2ABC: { status: 502, json: null, text: 'bad gateway' } } });
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet });
  assert.equal((await geo.locatePrecise('DL1ABC')).precision, 'entity');
  assert.equal((await geo.locatePrecise('DL2ABC')).precision, 'entity');
  const station = await geo.stationFor('DL1ABC');
  assert.ok(station, '404 payload carries no row → cty match is still a station card');
  assert.equal(station.callsign, 'DL1ABC');
  assert.equal(station.precision, 'entity');
  assert.equal(station.name, null);
  assert.deepEqual(station.sources, ['cty.dat']);
  const after5xx = await geo.stationFor('DL2ABC');
  assert.equal(after5xx?.precision, 'entity', '5xx also falls back to the cty card');
});

test('locatePrecise: without a client it is cty only', async () => {
  const geo = createGeolocator({ cty: fakeCty(), client: null, log: quiet });
  assert.equal((await geo.locatePrecise('DL1ABC')).precision, 'entity');
  const station = await geo.stationFor('DL1ABC');
  assert.ok(station, 'cty alone yields a station card');
  assert.equal(station.callsign, 'DL1ABC');
  assert.equal(station.precision, 'entity');
  assert.equal(station.name, null);
  assert.deepEqual(station.sources, ['cty.dat']);
  assert.equal(station.lat, 51);
  assert.equal(station.lon, 10);
});

test('stationFor: slash call whose callsign-db path 404s (Apache HTML) still gets a cty station card', async () => {
  // HamRig's Apache front end rejects %2F in the path (AllowEncodedSlashes off) with an HTML 404.
  const client = fakeClient({ db: { 'DL2SBY/P': { status: 404, json: null, text: '<html><body>Not Found</body></html>' } } });
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet });
  const station = await geo.stationFor('DL2SBY/P');
  assert.ok(station, 'a cty match is enough for a station card');
  assert.equal(station.callsign, 'DL2SBY/P');
  assert.equal(station.precision, 'entity');
  assert.equal(station.name, null);
  assert.equal(station.country, 'Fed. Rep. of Germany');
  assert.deepEqual(station.sources, ['cty.dat']);
  assert.equal(client.calls[0].path, '/api/public/callsign-db/DL2SBY%2FP');
  const loc = await geo.locatePrecise('DL2SBY/P');
  assert.equal(loc.precision, 'entity');
  assert.equal(client.calls.length, 1, 'station and loc share one cache entry');
  // Unknown everywhere (no cty match either) is still not a station.
  assert.equal(await geo.stationFor('ZZ9ZZZ'), null);
});

test('stationFor: synthesized cty card is upgraded by locate-calls when authenticated', async () => {
  const client = fakeClient({
    canAuthenticate: true,
    db: { 'IK6MNB/P': { status: 404, json: null, text: '<html>' } },
    located: { 'IK6MNB/P': { adif: 248, entity: 'Italy', lat: 43.5, lon: 13.5 } },
  });
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet });
  const station = await geo.stationFor('IK6MNB/P');
  assert.ok(station);
  assert.equal(station.lat, 43.5, 'prefix-row coordinates beat the cty centroid');
  assert.equal(station.lon, 13.5);
  assert.equal(station.precision, 'entity');
  assert.deepEqual(station.sources, ['cty.dat']);
});

test('concurrency queue limits in-flight lookups and shares duplicates', async () => {
  let inFlight = 0;
  let peak = 0;
  const gates = [];
  const client = fakeClient({
    db: { DH5DAX },
    delayGet: () => new Promise((resolve) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      gates.push(() => { inFlight -= 1; resolve(); });
    }),
  });
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet, concurrency: 2 });
  const calls = ['DL1AAA', 'DL1BBB', 'DL1CCC', 'DL1DDD', 'DL1AAA', 'dl1aaa-#'];
  const promise = Promise.all(calls.map((c) => geo.locatePrecise(c)));
  await new Promise((r) => setImmediate(r));
  const stats = geo.stats();
  assert.equal(stats.active, 2);
  assert.equal(stats.queued, 2);
  assert.equal(stats.inFlight, 4, 'four distinct keys pending');
  while (gates.length > 0) {
    gates.shift()();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  await promise;
  assert.equal(peak, 2);
  assert.equal(client.calls.length, 4, 'duplicate keys share one lookup');
  assert.equal(geo.stats().inFlight, 0);
  assert.equal(geo.stats().queued, 0);
});

test('LRU cache evicts the least recently used entry at maxCache', async () => {
  const client = fakeClient({ db: { DH5DAX } });
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet, maxCache: 2 });
  await geo.locatePrecise('DL1AAA');
  await geo.locatePrecise('DL1BBB');
  await geo.locatePrecise('DL1AAA'); // touch → BBB is now the oldest
  await geo.locatePrecise('DL1CCC'); // evicts BBB
  assert.equal(geo.stats().cacheSize, 2);
  assert.equal(geo.stats().evictions, 1);
  const before = client.calls.length;
  await geo.locatePrecise('DL1AAA');
  assert.equal(client.calls.length, before, 'AAA still cached');
  await geo.locatePrecise('DL1BBB');
  assert.equal(client.calls.length, before + 1, 'BBB was evicted');
});

test('locateMany(precise:false) never hits the network but uses precise cache hits', async () => {
  const client = fakeClient({ db: { DH5DAX } });
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet });
  await geo.locatePrecise('DH5DAX');
  const before = client.calls.length;
  const map = await geo.locateMany(['DH5DAX', 'DL8LAS-#', 'W6ABC', 'ZZ9ZZZ', 'dh5dax', '', null]);
  assert.equal(client.calls.length, before);
  assert.deepEqual([...map.keys()], ['DH5DAX', 'DL8LAS', 'W6ABC', 'ZZ9ZZZ']);
  assert.equal(map.get('DH5DAX').precision, 'exact');
  assert.equal(map.get('DL8LAS').precision, 'entity');
  assert.equal(map.get('W6ABC').precision, 'area');
  assert.equal(map.get('ZZ9ZZZ'), null);
});

test('locateMany(precise:true) resolves every call through locatePrecise', async () => {
  const client = fakeClient({ db: { DH5DAX } });
  const geo = createGeolocator({ cty: fakeCty(), client, log: quiet });
  const map = await geo.locateMany(['DH5DAX', 'DL9ZQX', 'ZZ9ZZZ'], { precise: true });
  assert.equal(map.get('DH5DAX').precision, 'exact');
  assert.equal(map.get('DL9ZQX').precision, 'entity');
  assert.equal(map.get('ZZ9ZZZ'), null);
  assert.equal(client.calls.length, 3);
  assert.equal(map.size, 3);
});

test('locateMany with an empty or bad argument resolves an empty map', async () => {
  const geo = createGeolocator({ cty: fakeCty(), client: fakeClient(), log: quiet });
  assert.equal((await geo.locateMany([])).size, 0);
  assert.equal((await geo.locateMany(null)).size, 0);
  assert.equal((await geo.locateMany('DL1ABC')).size, 0);
});
