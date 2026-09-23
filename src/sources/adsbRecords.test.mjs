import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LOCAL_ADSB_MESSAGE_STALE_MS,
  LOCAL_ADSB_POSITION_STALE_MS,
  localAdsbPositionIsFresh,
  localAdsbRecordIsLive,
  mergeLocalAdsbRecords,
  normalizeDump1090Aircraft,
  recordFromDecoderTrack,
  summarizeLocalAdsb,
} from './adsbRecords.js';

const dump1090 = JSON.parse(
  readFileSync(
    new URL(
      '../data/fixtures/adsb-austin-dump1090-aircraft.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

test('dump1090 aircraft.json maps to the shared local ADS-B records', () => {
  const now = 1_790_127_100_000;
  const records = normalizeDump1090Aircraft(dump1090, now);
  assert.equal(records.length, 4);
  const byIcao = new Map(records.map((record) => [record.icao, record]));

  assert.deepEqual(byIcao.get('ae5d8a'), {
    icao: 'ae5d8a',
    callsign: 'SHINR42',
    lat: 30.269662,
    lon: -97.793262,
    altitudeFt: 1600,
    groundSpeedKt: 129.9,
    trackDeg: 330.5,
    verticalRateFpm: 64,
    lastPositionAt: now - 34_600,
    lastMessageAt: now - 30_500,
    messageCount: 74,
    rssiDbfs: -30,
    band: '1090',
    source: 'feed',
  });
  const cruise = byIcao.get('a3c775');
  assert.equal(cruise.callsign, null);
  assert.equal(cruise.altitudeFt, 34_000);
  assert.equal(cruise.lat, 30.360625);
  assert.equal(cruise.lon, -97.919659);
  assert.equal(cruise.lastPositionAt, now - 43_400);

  const unpositioned = byIcao.get('a15c54');
  assert.equal(unpositioned.callsign, 'SKW3301');
  assert.equal(unpositioned.lat, null);
  assert.equal(unpositioned.lon, null);
  assert.equal(unpositioned.lastPositionAt, null);
  assert.equal(byIcao.get('a46e6a').altitudeFt, null);

  const summary = summarizeLocalAdsb(records, now);
  assert.deepEqual(summary, { heard: 4, positioned: 2 });
});

test('dump1090 adapter skips invalid addresses and tolerates missing fields', () => {
  const records = normalizeDump1090Aircraft(
    {
      now: 1,
      aircraft: [
        { hex: '~12ab34', seen: 1 },
        { hex: 'zzzzzz' },
        { hex: 'ABC123', alt_baro: 'ground', lat: 95, lon: 10, seen_pos: 1 },
      ],
    },
    10_000,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].icao, 'abc123');
  assert.equal(records[0].altitudeFt, 0);
  assert.equal(records[0].lat, null, 'out-of-range latitude is rejected');
  assert.equal(records[0].lastMessageAt, 10_000);
  assert.deepEqual(normalizeDump1090Aircraft(null, 1), []);
  assert.deepEqual(normalizeDump1090Aircraft({ aircraft: [] }, Number.NaN), []);
});

test('decoder tracks map to the same record shape', () => {
  const record = recordFromDecoderTrack({
    icao: 'AE5D8A',
    callsign: 'SHINR42',
    latitude: 30.27,
    longitude: -97.79,
    altitudeFt: 1600,
    speedKt: 129.9,
    headingDeg: -29.5,
    verticalRateFpm: 64,
    messages: 48,
    lastSeen: 5_000,
    lastPositionAt: 4_000,
    cprEven: {},
  });
  assert.deepEqual(record, {
    icao: 'ae5d8a',
    callsign: 'SHINR42',
    lat: 30.27,
    lon: -97.79,
    altitudeFt: 1600,
    groundSpeedKt: 129.9,
    trackDeg: 330.5,
    verticalRateFpm: 64,
    lastPositionAt: 4_000,
    lastMessageAt: 5_000,
    messageCount: 48,
    rssiDbfs: null,
    band: '1090',
    source: 'webusb',
  });
  assert.equal(recordFromDecoderTrack({ icao: 'nothex' }), null);
});

test('markers need a position newer than 60 s; records need a message newer than 60 s', () => {
  assert.equal(LOCAL_ADSB_POSITION_STALE_MS, 60_000);
  assert.equal(LOCAL_ADSB_MESSAGE_STALE_MS, 60_000);
  const record = {
    lat: 30,
    lon: -97,
    lastPositionAt: 0,
    lastMessageAt: 50_000,
  };
  assert.equal(localAdsbPositionIsFresh(record, 59_999), true);
  assert.equal(
    localAdsbPositionIsFresh(record, 60_000),
    false,
    'still heard, but the position is too old to draw',
  );
  assert.equal(localAdsbRecordIsLive(record, 60_000), true);
  assert.equal(localAdsbRecordIsLive(record, 110_000), false);
  assert.equal(
    localAdsbPositionIsFresh({ ...record, lat: null }, 1_000),
    false,
  );
});

test('a feed document names its band on every record', () => {
  const now = 1_790_127_100_000;
  const uat = normalizeDump1090Aircraft(dump1090, now, { band: '978' });
  assert.equal(uat.length, 4);
  assert.ok(uat.every((record) => record.band === '978'));
  assert.ok(uat.every((record) => record.source === 'feed'));
});

function heard(overrides = {}) {
  return {
    icao: 'abc123',
    lat: 30,
    lon: -97,
    lastPositionAt: 10_000,
    lastMessageAt: 10_000,
    band: '1090',
    source: 'webusb',
    ...overrides,
  };
}

test('merge keeps the most recent position per ICAO, then the most recent message', () => {
  const memory = new Map();
  const webusb = heard({ lastPositionAt: 9_000, lastMessageAt: 11_000 });
  const feed = heard({
    lat: 31,
    source: 'feed',
    lastPositionAt: 10_000,
    lastMessageAt: 10_000,
  });
  let [merged] = mergeLocalAdsbRecords([[webusb], [feed]], 12_000, memory);
  assert.equal(merged.lat, 31, 'the newer position wins over a newer message');
  assert.deepEqual(merged.bands, ['1090']);
  assert.deepEqual(merged.sources, ['webusb', 'feed']);

  // Equal positions: the newer message breaks the tie, in either input order.
  const tieA = heard({ lat: 1, lastMessageAt: 10_500 });
  const tieB = heard({ lat: 2, source: 'feed', lastMessageAt: 10_900 });
  for (const inputs of [
    [[tieA], [tieB]],
    [[tieB], [tieA]],
  ])
    assert.equal(mergeLocalAdsbRecords(inputs, 12_000)[0].lat, 2);

  // A positioned record beats one that has never decoded a position.
  const bare = heard({ lat: null, lon: null, lastPositionAt: null });
  [merged] = mergeLocalAdsbRecords(
    [[{ ...bare, lastMessageAt: 11_900 }], [heard({ band: '978', source: 'feed' })]],
    12_000,
  );
  assert.equal(merged.lat, 30);
  assert.equal(merged.band, '978');
  assert.deepEqual(merged.bands, ['1090', '978']);
});

test('merge remembers the bands and sources that heard an aircraft for 60 s', () => {
  const memory = new Map();
  mergeLocalAdsbRecords(
    [[heard()], [heard({ band: '978', source: 'feed', lastMessageAt: 20_000 })]],
    20_000,
    memory,
  );
  // The 978 feed drops the aircraft; the 1090 browser SDR still hears it.
  let [merged] = mergeLocalAdsbRecords(
    [[heard({ lastMessageAt: 60_000, lastPositionAt: 60_000 })], []],
    60_000,
    memory,
  );
  assert.deepEqual(merged.bands, ['1090', '978']);
  assert.deepEqual(merged.sources, ['webusb', 'feed']);
  [merged] = mergeLocalAdsbRecords(
    [[heard({ lastMessageAt: 80_000, lastPositionAt: 80_000 })], []],
    80_000,
    memory,
  );
  assert.deepEqual(merged.bands, ['1090'], '978 reception expired after 60 s');
  assert.deepEqual(merged.sources, ['webusb']);
  assert.deepEqual(mergeLocalAdsbRecords([[], []], 200_000, memory), []);
  assert.equal(memory.size, 0, 'the reception log is pruned');
});
