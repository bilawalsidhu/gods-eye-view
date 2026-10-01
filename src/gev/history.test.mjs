import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStore } from '../../server/providers/store/store.js';
import { sqliteDriver } from '../../server/providers/store/drivers.js';
import { _setStoreForTest } from '../../server/providers/store/index.js';
import {
  shouldKeep,
  parseRegions,
  distanceM,
  bearingDelta,
} from '../../server/providers/history/thinning.js';
import { createRecorder } from '../../server/providers/history/recorder.js';
import { historyHandler } from '../../server/providers/history/index.js';
import {
  observationsFromOpenSky,
  onObservations,
  publishOpenSkyBody,
} from '../../server/providers/common/observations.js';
import { tracksToCsv, tracksToKml, tracksToGeoJson } from '../../server/providers/history/export.js';

const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
const air = (id, t, lat, lon, extra = {}) => ({
  domain: 'air',
  id,
  t,
  lat,
  lon,
  alt: 10000,
  speed: 230,
  course: 90,
  label: 'TEST123',
  squawk: '1200',
  onGround: false,
  ...extra,
});

async function memoryStore() {
  const store = createStore(await sqliteDriver(':memory:'));
  await store.init();
  return store;
}

test('thinning keeps first, drops redundant, keeps moves, turns, squawk and heartbeat', () => {
  const a = air('abc123', T0, 38, -121);
  assert.equal(shouldKeep(null, a).reason, 'first');
  assert.equal(shouldKeep(a, air('abc123', T0 + 5000, 38, -121.001)).reason, 'too-soon');
  assert.equal(shouldKeep(a, air('abc123', T0 + 20000, 38, -121.05)).reason, 'moved');
  assert.equal(
    shouldKeep(a, air('abc123', T0 + 1000, 38, -121, { squawk: '7700' })).reason,
    'squawk',
  );
  assert.equal(
    shouldKeep(a, air('abc123', T0 + 20000, 38, -121.001, { course: 180 })).reason,
    'turn',
  );
  assert.equal(shouldKeep(a, air('abc123', T0 + 20000, 38, -121)).reason, 'redundant');
  assert.equal(shouldKeep(a, air('abc123', T0 + 400000, 38, -121)).reason, 'heartbeat');
  assert.equal(shouldKeep(a, air('abc123', T0 - 1, 38, -121.5)).reason, 'not-newer');
  assert.equal(shouldKeep(a, air('abc123', T0 + 20000, 45, -121)).reason, 'implausible-jump');
});

test('geometry helpers', () => {
  assert.ok(Math.abs(distanceM(0, 0, 0, 1) - 111195) < 50);
  assert.equal(bearingDelta(350, 10), 20);
  assert.equal(bearingDelta(10, 350), 20);
  const { regions, errors } = parseRegions('bay:37,-123,38.5,-121.5;bad:1,2;:10,10,11,11');
  assert.equal(regions.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(regions[0].name, 'bay');
});

test('OpenSky body becomes observations; invalid rows are skipped', () => {
  const obs = observationsFromOpenSky({
    time: 1_700_000_000,
    states: [
      ['ABC123', 'UAL1  ', 'United States', 1_700_000_000, 1, -121.5, 38.5, 9000, false, 220, 270, 0, null, 9100, '7700'],
      ['nothex', 'X', 'Y', 1, 1, 0, 0],
      ['def456', null, 'Z', null, 1_699_999_990, null, 38],
    ],
  });
  assert.equal(obs.length, 1);
  assert.deepEqual(
    { id: obs[0].id, label: obs[0].label, alt: obs[0].alt, squawk: obs[0].squawk, t: obs[0].t },
    { id: 'abc123', label: 'UAL1', alt: 9100, squawk: '7700', t: 1_700_000_000_000 },
  );
});

test('publishOpenSkyBody reaches subscribers asynchronously', async () => {
  const got = await new Promise((resolve) => {
    const off = onObservations((batch) => {
      off();
      resolve(batch);
    });
    publishOpenSkyBody(
      JSON.stringify({ time: 1, states: [['a1b2c3', 'X', 'C', 1, 1, 1, 1]] }),
    );
  });
  assert.equal(got[0].id, 'a1b2c3');
});

test('store round-trips fixes, snapshot, range, assets and retention', async () => {
  const store = await memoryStore();
  await store.insertFixes([
    { ...air('abc123', T0, 38, -121), pinned: false },
    { ...air('abc123', T0 + 60000, 38, -120.9), pinned: false },
    { ...air('fff000', T0 + 30000, 10, 10, { label: 'FAR' }), pinned: true },
    { domain: 'sea', id: '366999999', t: T0, lat: 37.8, lon: -122.4, label: 'TUG', meta: { imo: '1' } },
  ]);
  const track = await store.track({ domain: 'air', id: 'abc123', from: T0, to: T0 + 60000 });
  assert.equal(track.length, 2);
  assert.equal(track[1].lon, -120.9);

  const snap = await store.snapshot({ at: T0 + 60000, windowMs: 120000 });
  assert.equal(snap.length, 3);
  const box = { minLat: 30, minLon: -130, maxLat: 40, maxLon: -110 };
  const boxed = await store.snapshot({ at: T0 + 60000, windowMs: 120000, bbox: box, domain: 'air' });
  assert.deepEqual(boxed.map((f) => f.id), ['abc123']);
  assert.equal(boxed[0].lon, -120.9, 'snapshot returns the latest fix');
  assert.equal(boxed[0].label, 'TEST123');

  const range = await store.range({ from: T0, to: T0 + 60000, bbox: box });
  assert.equal(range.length, 3);

  const found = await store.searchAssets({ q: 'tug' });
  assert.equal(found[0].id, '366999999');
  assert.deepEqual(found[0].meta, { imo: '1' });
  const asset = await store.asset('air', 'abc123');
  assert.equal(asset.firstSeen, T0);
  assert.equal(asset.lastSeen, T0 + 60000);
  assert.equal(asset.lastLon, -120.9);

  const now = T0 + 3 * 86_400_000;
  await store.prune({
    now,
    unpinnedMs: 48 * 3_600_000,
    pinnedMs: 30 * 86_400_000,
    downsampleAfterMs: 7 * 86_400_000,
    downsampleBucketMs: 120000,
    camMs: 86_400_000,
    alertsMs: 86_400_000,
  });
  const stats = await store.stats();
  assert.equal(stats.fixes, 1, 'only the pinned fix survives 48 h retention');
  assert.equal(stats.byDomain.air, 1);
});

test('downsampling keeps one fix per bucket for old pinned data', async () => {
  const store = await memoryStore();
  const base = T0 - (T0 % 120000);
  await store.insertFixes([
    { ...air('aaa111', base, 1, 1), pinned: true },
    { ...air('aaa111', base + 30000, 1, 1.01), pinned: true },
    { ...air('aaa111', base + 60000, 1, 1.02), pinned: true },
    { ...air('aaa111', base + 120000, 1, 1.03), pinned: true },
  ]);
  const out = await store.prune({
    now: base + 8 * 86_400_000,
    unpinnedMs: 3_600_000,
    pinnedMs: 30 * 86_400_000,
    downsampleAfterMs: 7 * 86_400_000,
    downsampleBucketMs: 120000,
    camMs: 86_400_000,
    alertsMs: 86_400_000,
  });
  assert.equal(out.downsampled, 2);
  const kept = await store.track({ domain: 'air', id: 'aaa111', from: 0, to: base + 1e9 });
  assert.deepEqual(kept.map((f) => f.t), [base, base + 120000]);
});

test('records, alerts and camera samples are owner-scoped', async () => {
  const store = await memoryStore();
  await store.putRecord('watchlist', 'u1', 'w1', { name: 'A' });
  await store.putRecord('watchlist', 'u2', 'w1', { name: 'B' });
  assert.equal((await store.listRecords('watchlist', 'u1'))[0].name, 'A');
  await store.insertAlert({ id: 'x', owner: 'u1', t: T0, kind: 'fence-enter', severity: 'info', title: 'hi', detail: { a: 1 } });
  assert.equal((await store.listAlerts({ owner: 'u2' })).length, 0);
  const [alert] = await store.listAlerts({ owner: 'u1' });
  assert.deepEqual(alert.detail, { a: 1 });
  await store.ackAlert('u1', 'x');
  assert.equal((await store.listAlerts({ owner: 'u1' }))[0].acked, true);
  await store.insertCamSamples([
    { camera: 'c1', t: T0, ok: true },
    { camera: 'c1', t: T0 + 1, ok: false },
  ]);
  const [up] = await store.camUptime({ from: 0, to: T0 + 10 });
  assert.equal(up.uptime, 0.5);
});

test('recorder thins, pins regions, flushes and survives a store error', async () => {
  const store = await memoryStore();
  let fail = true;
  const flaky = {
    ...store,
    insertFixes: async (f) => {
      if (fail) {
        fail = false;
        throw new Error('disk busy');
      }
      return store.insertFixes(f);
    },
  };
  const rec = createRecorder({
    getStore: async () => flaky,
    regions: () => [{ name: 'r', minLat: 37, minLon: -122, maxLat: 39, maxLon: -120 }],
    isWatched: (d, id) => id === 'watch1',
    recordUnpinned: false,
  });
  rec.ingest([
    air('abc123', T0, 38, -121),
    air('abc123', T0 + 1000, 38, -121.0001),
    air('zzz999', T0, 0, 0),
    air('watch1', T0, 0, 0),
  ]);
  assert.equal(rec.stats().kept, 2);
  await assert.rejects(rec.flush());
  assert.equal(rec.stats().buffered, 2, 'batch restored after failure');
  await rec.flush();
  const stats = await store.stats();
  assert.equal(stats.fixes, 2);
  const snap = await store.snapshot({ at: T0, windowMs: 1000 });
  assert.ok(snap.every((f) => f.pinned));
});

test('export formats escape and neutralize feed-supplied text', () => {
  const groups = [
    {
      asset: { domain: 'air', id: 'abc123', label: '=HYPERLINK("x")' },
      fixes: [{ t: T0, lat: 1, lon: 2, alt: 3 }],
    },
  ];
  const csv = tracksToCsv(groups);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  const kml = tracksToKml([{ asset: { ...groups[0].asset, label: '<b>&' }, fixes: groups[0].fixes }]);
  assert.match(kml, /&lt;b&gt;&amp;/);
  const gj = tracksToGeoJson(groups);
  assert.deepEqual(gj.features[0].geometry.coordinates, [[2, 1, 3]]);
});

test('HTTP routes validate input and serve history', async () => {
  const store = await memoryStore();
  _setStoreForTest(store);
  await store.insertFixes([
    { ...air('abc123', T0, 38, -121), pinned: false },
    { ...air('abc123', T0 + 60000, 38, -120.9), pinned: false },
  ]);
  const fakeRuntime = {
    recorder: { stats: () => ({ received: 0 }) },
    regions: () => [],
    envRegions: [],
    retention: {},
    setStoredRegions() {},
  };
  const handler = historyHandler(fakeRuntime);
  const server = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/history/, '') || '/';
    handler(req, res, () => {
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/history`;
  try {
    let r = await fetch(`${base}/track?domain=air&id=abc123&from=${T0}&to=${T0 + 60000}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.fixes.length, 2);
    assert.equal(body.asset.label, 'TEST123');

    r = await fetch(`${base}/track?domain=space&id=abc123`);
    assert.equal(r.status, 400);
    r = await fetch(`${base}/track?domain=air&id=../../etc`);
    assert.equal(r.status, 400);

    r = await fetch(`${base}/track?domain=air&id=abc123&from=${T0}&to=${T0 + 60000}&format=csv`);
    assert.equal(r.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal((await r.text()).trim().split('\n').length, 3);

    r = await fetch(`${base}/range?from=${T0}&to=${T0 + 7 * 3_600_000}`);
    assert.equal(r.status, 400, 'range span is capped');
    r = await fetch(`${base}/range?from=${T0}&to=${T0 + 60000}`);
    const range = await r.json();
    assert.equal(range.tracks[0].fixes.length, 2);

    r = await fetch(`${base}/snapshot?at=${T0 + 60000}&bbox=37,-122,39,-120`);
    assert.equal((await r.json()).count, 1);

    r = await fetch(`${base}/regions`, {
      method: 'PUT',
      body: JSON.stringify({ regions: [{ name: 'bay', minLat: 37, minLon: -123, maxLat: 38.5, maxLon: -121 }] }),
    });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/regions`, { method: 'PUT', body: '{"regions":[{"name":"x"}]}' });
    assert.equal(r.status, 400);
    r = await fetch(`${base}/regions`, { method: 'PUT', body: 'nope' });
    assert.equal(r.status, 400);

    r = await fetch(`${base}/status`);
    assert.equal((await r.json()).store.fixes, 2);
    r = await fetch(`${base}/nope`);
    assert.equal(r.status, 404);
  } finally {
    server.close();
    _setStoreForTest(null);
  }
});
