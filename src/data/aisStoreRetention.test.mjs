import test from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;
const freshStore = () =>
  import(`../../server/providers/vessels/ais-store.js?retention=${instance++}`);
const envelope = (mmsi, at, lat = 25, extra = {}) => ({
  MessageType: 'PositionReport',
  MetaData: {
    MMSI: String(mmsi),
    latitude: lat,
    longitude: 56,
    ...(at === undefined ? {} : { time_utc: new Date(at).toISOString() }),
  },
  Message: {
    PositionReport: { UserID: Number(mmsi), Sog: 10, Cog: 90, ...extra },
  },
});

test('AIS snapshots and tracks expire at the public retention boundary without new traffic', async (t) => {
  const store = await freshStore();
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  assert.equal(store.ingestAisStreamEnvelope(envelope(200000001, now)), true);
  now += 31000;
  store.ingestAisStreamEnvelope(envelope(200000001, now, 25.001));
  assert.equal(store.readAisTrack('200000001').length, 2);
  now += store.AISSTREAM_STALE_MS;
  assert.equal(store.aisStreamRows(10).length, 1, 'cutoff is inclusive');
  now++;
  assert.deepEqual(store.aisStreamRows(10), []);
  assert.deepEqual(
    store.readAisTrack('200000001'),
    [],
    'expired history is never served while cleanup is deferred',
  );
});

test('AIS store stays hard-bounded during a burst and retains recently refreshed vessels', async (t) => {
  const store = await freshStore();
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  store.ingestAisStreamEnvelope(envelope(200000000, now));
  now += 31000;
  store.ingestAisStreamEnvelope(envelope(200000000, now, 25.001));
  assert.equal(store.readAisTrack('200000000').length, 2);
  for (let i = 1; i < store.AISSTREAM_CACHE_MAX; i++) {
    now++;
    store.ingestAisStreamEnvelope(envelope(200000000 + i, now));
  }
  now++;
  store.ingestAisStreamEnvelope(envelope(200000001, now, 25.002));
  for (let i = 0; i < 100; i++) {
    now++;
    store.ingestAisStreamEnvelope(envelope(300000000 + i, now));
  }
  const rows = store.aisStreamRows(store.AISSTREAM_CACHE_MAX + 1);
  assert.equal(rows.length, store.AISSTREAM_CACHE_MAX);
  assert.ok(rows.some((row) => row.mmsi === '200000001' && row.lat === 25.002));
  assert.ok(!rows.some((row) => row.mmsi === '200000000'));
  assert.deepEqual(
    store.readAisTrack('200000000'),
    [],
    'capacity eviction releases its track',
  );
  assert.equal(rows[0].mmsi, '300000099');
  now++;
  store.ingestAisStreamEnvelope(envelope(200000000, now, 25.004));
  assert.deepEqual(
    store.readAisTrack('200000000'),
    [],
    'reappearing vessel cannot inherit the evicted path',
  );
});

test('static vessel metadata, position updates and out-of-order report times keep their meaning', async (t) => {
  const store = await freshStore();
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  store.ingestAisStreamEnvelope({
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: '200000003' },
    Message: {
      ShipStaticData: {
        UserID: 200000003,
        Name: 'TEST TANKER',
        Type: 80,
        Destination: 'TEST PORT',
      },
    },
  });
  store.ingestAisStreamEnvelope(envelope(200000003, now));
  now += 31000;
  store.ingestAisStreamEnvelope(envelope(200000003, now, 25.001));
  const latestEpoch = Math.floor(now / 1000);
  now += 1000;
  store.ingestAisStreamEnvelope(envelope(200000003, now - 60000, 25.002));
  const row = store.aisStreamRows(1)[0];
  assert.equal(row.name, 'TEST TANKER');
  assert.equal(row.type, '80');
  assert.equal(row.destination, 'TEST PORT');
  assert.equal(row.last_position_epoch, Math.floor((now - 60000) / 1000));
  assert.equal(
    store.readAisTrack('200000003').at(-1).t,
    latestEpoch,
    'late AIS report does not append backward history',
  );
  assert.equal(Object.hasOwn(row, '_updatedAt'), false);
  assert.equal(
    store.ingestAisStreamEnvelope({ MetaData: { MMSI: '200000009' } }),
    false,
  );
});

test('missing or invalid AIS timestamps use one consistent receipt time', async (t) => {
  const store = await freshStore();
  const now = 1800000000123;
  t.mock.method(Date, 'now', () => now);
  store.ingestAisStreamEnvelope(envelope(200000004, undefined));
  const invalid = envelope(200000005, undefined);
  invalid.MetaData.time_utc = 'invalid';
  store.ingestAisStreamEnvelope(invalid);
  for (const row of store.aisStreamRows(2)) {
    assert.equal(row.last_position_UTC, new Date(now).toISOString());
    assert.equal(row.last_position_epoch, Math.floor(now / 1000));
  }
});
