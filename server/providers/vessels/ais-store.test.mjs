import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from './ais-store.js';
import { aisLiveProxy } from './ais-live.js';

const { AISSTREAM_CACHE_MAX, AISSTREAM_STALE_MS } = store;

// One clock for the whole file, only ever moved forward. The store is module
// state shared by every test here, so each test starts by stepping past the
// retention window: every vessel an earlier test left behind has expired.
// Static entries without a vessel row never expire, so a test that leaves
// many of them uses a store of its own.
let now = Date.parse('2030-01-01T00:00:00Z');
const useClock = (t) => {
  now += AISSTREAM_STALE_MS + 60_000;
  t.mock.method(Date, 'now', () => now);
};

/** Message helpers bound to one store module instance. */
const feed = (target) => {
  const position = (mmsi, lat = 53.4, extraMetaData = {}) =>
    target.ingestAisStreamEnvelope({
      MessageType: 'PositionReport',
      Message: { PositionReport: { UserID: Number(mmsi), Sog: 10, Cog: 90 } },
      MetaData: {
        MMSI: mmsi,
        latitude: lat,
        longitude: 6.2,
        time_utc: new Date(now).toISOString(),
        ...extraMetaData,
      },
    });
  // No position in the header, so this never creates a vessel row by itself.
  const staticData = (mmsi, body) =>
    target.ingestAisStreamEnvelope({
      MessageType: 'ShipStaticData',
      Message: { ShipStaticData: { UserID: Number(mmsi), ...body } },
      MetaData: { MMSI: mmsi },
    });
  const rows = () => target.aisStreamRows(AISSTREAM_CACHE_MAX);
  const rowFor = (mmsi) => rows().find((row) => row.mmsi === mmsi);
  return { position, staticData, rows, rowFor };
};

const { position, staticData, rows, rowFor } = feed(store);
const mmsiAt = (index) => String(300000000 + index);

/** Fill the store to exactly the cap with vessels 0..cap-1, oldest first. */
const fillToCap = () => {
  for (let index = 0; index < AISSTREAM_CACHE_MAX; index++) {
    now += 1;
    position(mmsiAt(index));
  }
};

test('ingest leaves expired vessels to the timed prune', (t) => {
  useClock(t);
  store.pruneAisStreamCache();
  position('210000001');
  now += AISSTREAM_STALE_MS + 1;
  position('210000002');
  assert.equal(store.aisStreamCacheStats().vessels, 2);
  store.pruneAisStreamCache();
  assert.equal(store.aisStreamCacheStats().vessels, 1);
});

test('readers never see an expired vessel between timed prunes', (t) => {
  useClock(t);
  const mmsi = '211000001';
  position(mmsi, 53.4);
  now += 60_000;
  position(mmsi, 53.5);
  assert.equal(rowFor(mmsi).mmsi, mmsi);
  assert.equal(store.readAisTrack(mmsi).length, 2);

  // No prune and no other message: the entry is still in the maps.
  now += AISSTREAM_STALE_MS + 1;
  assert.equal(rowFor(mmsi), undefined);
  assert.deepEqual(store.readAisTrack(mmsi), []);
});

test('a vessel heard again after the retention window starts afresh, prune or not', (t) => {
  useClock(t);
  const mmsi = '211000004';
  staticData(mmsi, { Type: 70, Destination: 'HAMBURG' });
  position(mmsi, 53.4);
  now += 60_000;
  position(mmsi, 53.5);

  // Back before any prune ran: no old destination, no track across the gap.
  now += AISSTREAM_STALE_MS + 5_000;
  position(mmsi, 53.6);
  assert.equal(rowFor(mmsi).destination, '');
  assert.deepEqual(store.readAisTrack(mmsi), []);

  // A fresh static report reaching the expired row outlives the prune.
  now += AISSTREAM_STALE_MS + 5_000;
  staticData(mmsi, { Type: 70, Destination: 'NEWDEST' });
  store.pruneAisStreamCache();
  position(mmsi, 53.7);
  assert.equal(rowFor(mmsi).destination, 'NEWDEST');
});

test('a first fix older than the retention window never seeds a track', (t) => {
  useClock(t);
  const mmsi = '211000002';
  const old = new Date(now - AISSTREAM_STALE_MS - 60_000).toISOString();
  position(mmsi, 53.4, { time_utc: old });
  now += 60_000;
  position(mmsi, 53.5);
  assert.deepEqual(store.readAisTrack(mmsi), []);
});

test('past the cap the least recently updated vessel is evicted and its static entry kept', (t) => {
  useClock(t);
  store.pruneAisStreamCache();
  staticData(mmsiAt(0), { Type: 70, Destination: 'HAMBURG' });
  fillToCap();
  // Vessel 1 reports again, so it is no longer among the oldest.
  now += 1;
  position(mmsiAt(1));
  for (let index = 0; index < 3; index++) {
    now += 1;
    position(mmsiAt(AISSTREAM_CACHE_MAX + index));
    assert.equal(store.aisStreamCacheStats().vessels, AISSTREAM_CACHE_MAX);
  }

  const kept = new Set(rows().map((row) => row.mmsi));
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => kept.has(mmsiAt(index))),
    [false, true, false, false, true],
  );
  for (let index = 0; index < 3; index++)
    assert.ok(kept.has(mmsiAt(AISSTREAM_CACHE_MAX + index)));

  // The evicted vessel's static entry waits for its next position.
  now += 1;
  position(mmsiAt(0));
  assert.equal(rowFor(mmsiAt(0)).type, '70');
  assert.equal(rowFor(mmsiAt(0)).destination, 'HAMBURG');
});

test('the timed prune drops expired vessels and their static entries', (t) => {
  useClock(t);
  store.pruneAisStreamCache();
  assert.deepEqual(store.aisStreamCacheStats(), {
    vessels: 0,
    statics: 0,
    tracks: 0,
    pendingTracks: 0,
  });

  const mmsi = '211000003';
  // Static data ahead of the first position must still reach the row, and
  // must survive a prune while it waits.
  staticData(mmsi, { Type: 70, Destination: 'HAMBURG' });
  store.pruneAisStreamCache();
  position(mmsi, 53.4);
  now += 60_000;
  position(mmsi, 53.5);
  assert.equal(rowFor(mmsi).type, '70');
  assert.equal(rowFor(mmsi).destination, 'HAMBURG');
  const live = store.aisStreamCacheStats();
  assert.deepEqual([live.vessels, live.statics, live.tracks], [1, 1, 1]);

  now += AISSTREAM_STALE_MS + 1;
  store.pruneAisStreamCache();
  const pruned = store.aisStreamCacheStats();
  assert.deepEqual(
    [pruned.vessels, pruned.statics, pruned.tracks, pruned.pendingTracks],
    [0, 0, 0, 0],
  );
  position(mmsi, 53.6);
  assert.equal(rowFor(mmsi).type, '');
});

test('the AIS watchdog tick prunes a silent cache and stops once the server closes', (t) => {
  useClock(t);
  store.pruneAisStreamCache();
  // Without a key the tick opens no socket.
  const key = process.env.AISSTREAM_API_KEY;
  delete process.env.AISSTREAM_API_KEY;
  t.after(() => {
    if (key !== undefined) process.env.AISSTREAM_API_KEY = key;
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const plugin = aisLiveProxy();
  t.after(() => plugin.closeBundle());
  plugin.configureServer({ middlewares: { use() {} } });

  position('211000005');
  now += AISSTREAM_STALE_MS + 1;
  t.mock.timers.tick(15_000);
  assert.equal(store.aisStreamCacheStats().vessels, 0);

  plugin.closeBundle();
  position('211000006');
  now += AISSTREAM_STALE_MS + 1;
  t.mock.timers.tick(30_000);
  assert.equal(store.aisStreamCacheStats().vessels, 1);
});

test('static entries that never get a position are capped in order of first arrival', async (t) => {
  useClock(t);
  const own = await import('./ais-store.js?static-cap');
  const { position, staticData, rowFor } = feed(own);
  for (let index = 0; index < AISSTREAM_CACHE_MAX + 5; index++)
    staticData(mmsiAt(index), { Type: 70 });
  // A vessel with a row keeps its static entry however old that entry is.
  position(mmsiAt(0));
  assert.equal(own.aisStreamCacheStats().statics, AISSTREAM_CACHE_MAX + 5);

  own.pruneAisStreamCache();
  assert.equal(own.aisStreamCacheStats().statics, AISSTREAM_CACHE_MAX);
  now += 1;
  position(mmsiAt(0));
  position(mmsiAt(3));
  position(mmsiAt(AISSTREAM_CACHE_MAX));
  assert.equal(rowFor(mmsiAt(0)).type, '70');
  assert.equal(rowFor(mmsiAt(3)).type, '');
  assert.equal(rowFor(mmsiAt(AISSTREAM_CACHE_MAX)).type, '70');
});
