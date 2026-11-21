import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from './ais-store.js';

const { AISSTREAM_CACHE_MAX, AISSTREAM_STALE_MS } = store;

// One clock for the whole file, only ever moved forward. The store is module
// state shared by every test here, so each test starts by stepping past the
// retention window: whatever an earlier test left behind is already expired.
let now = Date.parse('2030-01-01T00:00:00Z');
const useClock = (t) => {
  now += AISSTREAM_STALE_MS + 60_000;
  t.mock.method(Date, 'now', () => now);
};

const position = (mmsi, lat = 53.4, extraMetaData = {}) =>
  store.ingestAisStreamEnvelope({
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
  store.ingestAisStreamEnvelope({
    MessageType: 'ShipStaticData',
    Message: { ShipStaticData: { UserID: Number(mmsi), ...body } },
    MetaData: { MMSI: mmsi },
  });

const rows = () => store.aisStreamRows(AISSTREAM_CACHE_MAX);
const rowFor = (mmsi) => rows().find((row) => row.mmsi === mmsi);
const mmsiAt = (index) => String(300000000 + index);

/** Fill the store to exactly the cap with vessels 0..cap-1, oldest first. */
const fillToCap = () => {
  for (let index = 0; index < AISSTREAM_CACHE_MAX; index++) {
    now += 1;
    position(mmsiAt(index));
  }
};

test('ingesting messages does not walk the whole cache per message', (t) => {
  useClock(t);
  const before = store.aisStreamCacheStats().pruneWalks;
  for (let index = 0; index < 2000; index++) {
    now += 1;
    position(String(210000000 + (index % 200)));
  }
  assert.equal(store.aisStreamCacheStats().pruneWalks, before);
  store.pruneAisStreamCache();
  assert.equal(store.aisStreamCacheStats().pruneWalks, before + 1);
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

test('a first fix older than the retention window never seeds a track', (t) => {
  useClock(t);
  const mmsi = '211000002';
  const old = new Date(now - AISSTREAM_STALE_MS - 60_000).toISOString();
  position(mmsi, 53.4, { time_utc: old });
  now += 60_000;
  position(mmsi, 53.5);
  assert.deepEqual(store.readAisTrack(mmsi), []);
});

test('past the cap the least recently updated vessels are evicted', (t) => {
  useClock(t);
  fillToCap();
  // Vessel 1 reports again, so it is no longer among the oldest.
  now += 1;
  position(mmsiAt(1));
  for (let index = 0; index < 3; index++) {
    now += 1;
    position(mmsiAt(AISSTREAM_CACHE_MAX + index));
  }

  const kept = new Set(rows().map((row) => row.mmsi));
  assert.equal(kept.size, AISSTREAM_CACHE_MAX);
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => kept.has(mmsiAt(index))),
    [false, true, false, false, true],
  );
  for (let index = 0; index < 3; index++)
    assert.ok(kept.has(mmsiAt(AISSTREAM_CACHE_MAX + index)));
});

test('an evicted vessel takes its static entry with it', (t) => {
  useClock(t);
  const evicted = mmsiAt(0);
  staticData(evicted, { Type: 70, Destination: 'HAMBURG' });
  fillToCap();
  assert.equal(rowFor(evicted).type, '70');
  now += 1;
  position(mmsiAt(AISSTREAM_CACHE_MAX));
  assert.equal(rowFor(evicted), undefined);

  // Were the static entry still cached, the next position would pick it up.
  now += 1;
  position(evicted);
  assert.equal(rowFor(evicted).type, '');
  assert.equal(rowFor(evicted).destination, '');
});

test('the timed prune drops expired vessels and their static entries', (t) => {
  useClock(t);
  store.pruneAisStreamCache();
  assert.deepEqual(
    { ...store.aisStreamCacheStats(), pruneWalks: 0 },
    { vessels: 0, statics: 0, tracks: 0, pendingTracks: 0, pruneWalks: 0 },
  );

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
  assert.deepEqual(
    [live.vessels, live.statics, live.tracks],
    [1, 1, 1],
  );

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

test('static entries that never get a position are capped, oldest first', (t) => {
  useClock(t);
  store.pruneAisStreamCache();
  for (let index = 0; index < AISSTREAM_CACHE_MAX + 5; index++)
    staticData(mmsiAt(index), { Type: 70 });
  // A vessel with a row keeps its static entry however old that entry is.
  position(mmsiAt(0));
  assert.equal(store.aisStreamCacheStats().statics, AISSTREAM_CACHE_MAX + 5);

  store.pruneAisStreamCache();
  assert.equal(store.aisStreamCacheStats().statics, AISSTREAM_CACHE_MAX);
  now += 1;
  position(mmsiAt(0));
  position(mmsiAt(3));
  position(mmsiAt(AISSTREAM_CACHE_MAX));
  assert.equal(rowFor(mmsiAt(0)).type, '70');
  assert.equal(rowFor(mmsiAt(3)).type, '');
  assert.equal(rowFor(mmsiAt(AISSTREAM_CACHE_MAX)).type, '70');
});
