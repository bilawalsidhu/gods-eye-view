import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeAdsbMessage,
  modeSChecksum,
  updateAircraftTrack,
} from '../sdr/adsbDecoder.js';

import {
  LOCAL_ADSB_MESSAGE_STALE_MS,
  LOCAL_ADSB_POSITION_STALE_MS,
  LOCAL_ADSB_REFERENCE_MAX_AGE_MS,
  createLocalAdsbAltitudeGate,
  gateLocalAdsbAltitude,
  localAdsbAltitudeIsPlausible,
  localAdsbFixIsPlausible,
  localAdsbPositionIsFresh,
  localAdsbRecordIsLive,
  normalizeAdsbCategory,
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
    category: null,
    onGround: false,
    lat: 30.269662,
    lon: -97.793262,
    altitudeFt: 1600,
    altitudeObservedAt: null,
    feedId: null,
    feedSnapshotAt: dump1090.now * 1000,
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
        {
          hex: 'ABC123',
          alt_baro: 'ground',
          lat: 95,
          lon: 10,
          seen_pos: 1,
          category: 'a7',
        },
        { hex: 'def456', category: 'E9', seen: 1 },
      ],
    },
    10_000,
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].icao, 'abc123');
  assert.equal(records[0].altitudeFt, 0);
  assert.equal(records[0].onGround, true, 'dump1090 "ground" is kept');
  assert.equal(records[0].category, 'A7');
  assert.equal(records[1].category, null, 'an invalid category is dropped');
  assert.equal(records[1].onGround, false);
  assert.equal(records[0].lat, null, 'out-of-range latitude is rejected');
  assert.equal(records[0].lastMessageAt, 10_000);
  assert.deepEqual(normalizeDump1090Aircraft(null, 1), []);
  assert.deepEqual(normalizeDump1090Aircraft({ aircraft: [] }, Number.NaN), []);
});

test('decoder tracks map to the same record shape', () => {
  const record = recordFromDecoderTrack({
    icao: 'AE5D8A',
    callsign: 'SHINR42',
    category: 'A1',
    latitude: 30.27,
    longitude: -97.79,
    altitudeFt: 1600,
    speedKt: 129.9,
    headingDeg: -29.5,
    verticalRateFpm: 64,
    messages: 48,
    lastSeen: 5_000,
    firstSeenAt: 1_000,
    lastAltitudeAt: 3_000,
    altitudeSequence: 2,
    lastPositionAt: 4_000,
    cprEven: {},
  });
  assert.deepEqual(record, {
    icao: 'ae5d8a',
    callsign: 'SHINR42',
    category: 'A1',
    onGround: false,
    lat: 30.27,
    lon: -97.79,
    altitudeFt: 1600,
    altitudeObservedAt: 3_000,
    altitudeSequence: 2,
    altitudeSessionAt: 1_000,
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
    [
      [{ ...bare, lastMessageAt: 11_900 }],
      [heard({ band: '978', source: 'feed' })],
    ],
    12_000,
  );
  assert.equal(merged.lat, 30);
  assert.equal(merged.band, '978');
  assert.deepEqual(merged.bands, ['1090', '978']);
});

test('merge remembers the bands and sources that heard an aircraft for 60 s', () => {
  const memory = new Map();
  mergeLocalAdsbRecords(
    [
      [heard()],
      [heard({ band: '978', source: 'feed', lastMessageAt: 20_000 })],
    ],
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

test('emitter categories normalize to the dump1090 strings', () => {
  assert.equal(normalizeAdsbCategory('a7'), 'A7');
  assert.equal(normalizeAdsbCategory(' B1 '), 'B1');
  assert.equal(normalizeAdsbCategory('A8'), null);
  assert.equal(normalizeAdsbCategory(7), null);
  assert.equal(normalizeAdsbCategory(null), null);
});

test('merging keeps a category decoded by any input', () => {
  const base = {
    icao: 'a0b702',
    lat: 30.2,
    lon: -97.8,
    lastMessageAt: 10_000,
    band: '1090',
  };
  const [merged] = mergeLocalAdsbRecords(
    [
      [{ ...base, category: null, lastPositionAt: 9_900, source: 'webusb' }],
      [{ ...base, category: 'A7', lastPositionAt: 9_000, source: 'feed' }],
    ],
    10_000,
  );
  assert.equal(merged.source, 'webusb', 'the newest position still wins');
  assert.equal(merged.category, 'A7');
});

test('the position sanity check follows dump1090: speed × 1.5 + margin over elapsed + 1 s', () => {
  const from = { lat: 30, lon: -97, at: 0 };
  // 1 nm north in 10 s: 360 kt.
  const next = { lat: 30 + 1 / 60, lon: -97, at: 10_000 };
  assert.equal(localAdsbFixIsPlausible(null, next), true, 'no reference');
  assert.equal(
    localAdsbFixIsPlausible(from, next, { groundSpeedKt: 300 }),
    true,
    '300 kt reported allows 500 kt',
  );
  assert.equal(
    localAdsbFixIsPlausible(from, next, { groundSpeedKt: 120 }),
    false,
    '120 kt reported allows 230 kt',
  );
  assert.equal(
    localAdsbFixIsPlausible(from, next),
    true,
    'unknown speed allows 1,000 kt',
  );
  // 2 nm in 10 s: 720 kt.
  const fast = { lat: 30 + 2 / 60, lon: -97, at: 10_000 };
  assert.equal(localAdsbFixIsPlausible(from, fast), true);
  assert.equal(
    localAdsbFixIsPlausible(from, fast, { category: 'A7' }),
    false,
    'rotorcraft without a speed are capped at 350 kt',
  );
  assert.equal(
    localAdsbFixIsPlausible(
      from,
      { ...next, lat: 31, at: LOCAL_ADSB_REFERENCE_MAX_AGE_MS + 1 },
      { groundSpeedKt: 100 },
    ),
    true,
    'a reference older than 10 minutes proves nothing',
  );
  assert.equal(
    localAdsbFixIsPlausible(
      from,
      { lat: 30.004, lon: -97, at: 0 },
      {
        groundSpeedKt: 0,
      },
    ),
    true,
    'the fixed 500 m margin absorbs CPR and reception error',
  );
});

test('the altitude check allows the vertical rate × 1.5 + margin over elapsed + 1 s', () => {
  const from = { altitudeFt: 30_000, at: 0, verticalRateFpm: null };
  // 9 s later, so the allowance covers 10 s: a sixth of a minute.
  const at = 9_000;
  const check = (altitudeFt, rates = {}) =>
    localAdsbAltitudeIsPlausible(
      { ...from, verticalRateFpm: rates.previous ?? null },
      { altitudeFt, at, verticalRateFpm: rates.next ?? null },
    );
  assert.equal(
    localAdsbAltitudeIsPlausible(null, { altitudeFt: 108_800, at }),
    true,
    'no reference',
  );
  // Unknown rate: 12,500 ft/min → 2,083 ft + 300 ft.
  assert.equal(check(32_380), true);
  assert.equal(check(32_390), false);
  assert.equal(check(27_620), true, 'the limit is symmetric');
  assert.equal(check(27_610), false);
  // Level flight reported: 2,000 ft/min → 333 ft + 300 ft.
  assert.equal(check(30_630, { previous: 0 }), true);
  assert.equal(check(30_640, { previous: 0 }), false);
  // The larger of the two reported rates counts: 6,000 × 1.5 + 2,000
  // = 11,000 ft/min → 1,833 ft + 300 ft.
  assert.equal(check(27_870, { previous: 0, next: -6_000 }), true);
  assert.equal(check(27_860, { previous: 0, next: -6_000 }), false);
  assert.equal(
    localAdsbAltitudeIsPlausible(
      { altitudeFt: 30_000, at: 9_000 },
      { altitudeFt: 30_400, at: 0 },
    ),
    true,
    'an out-of-order report gets the zero-gap allowance, not a negative one',
  );
});

/** Feed actual browser altitude reports, `[seconds, altitudeFt, extra]`. */
function gateReports(reports) {
  const gate = createLocalAdsbAltitudeGate();
  const altitudes = reports.map(
    ([seconds, altitudeFt, extra = {}]) =>
      gateLocalAdsbAltitude(
        {
          icao: 'abc123',
          lastMessageAt: seconds * 1_000,
          source: 'webusb',
          altitudeObservedAt: seconds * 1_000,
          altitudeSequence: seconds * 1_000 + 1,
          altitudeSessionAt: 0,
          altitudeFt,
          ...extra,
        },
        gate,
      ).altitudeFt,
  );
  return { altitudes, rejected: gate.rejected };
}

test('a corrupt altitude is held at the last accepted one and judged once', () => {
  // The logged case: a DC-9 cruising at 35,000 ft reported once at 108,800 ft.
  // The layer re-reads the same record several times a second; a re-read of
  // the refused report is neither let through nor counted again.
  assert.deepEqual(
    gateReports([
      [0, 35_000],
      [0.5, 35_000],
      [1, 108_800],
      [1, 108_800],
      [1, 108_800],
      [1.5, 35_025],
    ]),
    {
      altitudes: [35_000, 35_000, 35_000, 35_000, 35_000, 35_025],
      rejected: 1,
    },
  );
});

test('a bad first altitude clears itself on the third refusal', () => {
  assert.deepEqual(
    gateReports([
      [0, 108_800],
      [0.5, 35_000],
      [1, 35_000],
      [1.5, 35_000],
      [2, 35_000],
    ]),
    { altitudes: [108_800, 108_800, 108_800, 35_000, 35_000], rejected: 3 },
  );
});

test('a surface report is not compared with the last airborne altitude', () => {
  // Denver: the last airborne report is 5,600 ft barometric, and a feed
  // reports `alt_baro: "ground"` as 0. Neither the landing nor the next
  // takeoff is a jump.
  assert.deepEqual(
    gateReports([
      [0, 5_600],
      [20, 0, { onGround: true }],
      [300, 5_700],
      [301, 5_720],
    ]),
    { altitudes: [5_600, 0, 5_700, 5_720], rejected: 0 },
  );
});

function browserAltitude(altitudeFt, at, sequence, extra = {}) {
  return {
    icao: 'abc123',
    source: 'webusb',
    altitudeFt,
    altitudeObservedAt: at,
    altitudeSequence: sequence,
    altitudeSessionAt: 0,
    lastMessageAt: at,
    ...extra,
  };
}

function feedAltitude(altitudeFt, at, messages, extra = {}) {
  return {
    icao: 'abc123',
    source: 'feed',
    band: '1090',
    feedId: 'feed-1',
    feedSnapshotAt: at,
    messageCount: messages,
    altitudeFt,
    altitudeObservedAt: null,
    lastMessageAt: at,
    ...extra,
  };
}

test('non-altitude messages never recount a refusal or refresh its reference', () => {
  const gate = createLocalAdsbAltitudeGate();
  const first = browserAltitude(35_000, 0, 1);
  const bad = browserAltitude(108_800, 1_000, 2);
  gateLocalAdsbAltitude(first, gate, 0);
  let result = gateLocalAdsbAltitude(bad, gate, 1_000);
  for (const at of [2_000, 3_000, 9_000]) {
    result = gateLocalAdsbAltitude({ ...bad, lastMessageAt: at }, gate, at);
    assert.equal(result.altitudeFt, 35_000);
    assert.equal(result.altitudeObservedAt, 0);
    assert.equal(result.altitudeQuality, 'held-after-rejection');
  }
  assert.equal(gate.rejected, 1);
  // The true report is compared with the real 0 ms observation, not the
  // most recent identification/velocity message at 9 seconds.
  result = gateLocalAdsbAltitude(
    browserAltitude(37_000, 10_000, 3),
    gate,
    10_000,
  );
  assert.equal(result.altitudeFt, 37_000);
  assert.equal(result.altitudeObservedAt, 10_000);
  assert.equal(result.altitudeQuality, 'accepted');
  assert.equal(gate.rejected, 1);
  assert.equal(bad.altitudeFt, 108_800, 'input records are not rewritten');
});

test('same-valued real frames refresh time; same-ms frames each get one vote', () => {
  const gate = createLocalAdsbAltitudeGate();
  gateLocalAdsbAltitude(browserAltitude(35_000, 0, 1), gate, 0);
  let result = gateLocalAdsbAltitude(
    browserAltitude(35_000, 10_000, 2),
    gate,
    10_000,
  );
  assert.equal(result.altitudeObservedAt, 10_000);
  result = gateLocalAdsbAltitude(
    browserAltitude(37_000, 11_000, 3),
    gate,
    11_000,
  );
  assert.equal(result.altitudeFt, 35_000, 'recent level report limits the gap');
  for (const sequence of [4, 5])
    result = gateLocalAdsbAltitude(
      browserAltitude(37_000, 11_000, sequence),
      gate,
      11_000,
    );
  assert.equal(result.altitudeFt, 37_000);
  assert.equal(
    gate.rejected,
    3,
    'different frames in one USB block count individually',
  );
});

test('a browser sequence gap is one observation, and old/repeated tokens do not vote', () => {
  const gate = createLocalAdsbAltitudeGate();
  gateLocalAdsbAltitude(browserAltitude(35_000, 0, 1), gate, 0);
  const bad = browserAltitude(108_800, 1_000, 15);
  for (let n = 0; n < 4; n++) gateLocalAdsbAltitude(bad, gate, 1_000 + n);
  gateLocalAdsbAltitude(browserAltitude(108_800, 500, 3), gate, 2_000);
  assert.equal(gate.rejected, 1);
  assert.equal(gate.accepted.altitudeFt, 35_000);
});

test('sources and a new browser track cannot combine recovery streaks', () => {
  const gate = createLocalAdsbAltitudeGate();
  gateLocalAdsbAltitude(browserAltitude(35_000, 0, 1), gate, 0);
  gateLocalAdsbAltitude(browserAltitude(108_800, 1_000, 2), gate, 1_000);
  gateLocalAdsbAltitude(feedAltitude(108_800, 2_000, 2), gate, 2_000);
  let result = gateLocalAdsbAltitude(
    browserAltitude(108_800, 3_000, 3),
    gate,
    3_000,
  );
  assert.equal(
    result.altitudeFt,
    35_000,
    'two browser votes plus a feed refusal are not three browser votes',
  );
  result = gateLocalAdsbAltitude(
    browserAltitude(108_800, 4_000, 1, { altitudeSessionAt: 4_000 }),
    gate,
    4_000,
  );
  assert.equal(result.altitudeFt, 35_000, 'new track starts its own streak');
});

test("alternating receivers recover using each receiver's own observations", () => {
  for (const secondSource of ['browser', 'feed']) {
    const gate = createLocalAdsbAltitudeGate();
    gateLocalAdsbAltitude(feedAltitude(108_800, 0, 1), gate, 0);
    let result;
    for (let at = 1_000; at <= 7_000; at += 1_000) {
      const alternate = at % 2_000 === 0;
      const record =
        alternate && secondSource === 'browser'
          ? browserAltitude(35_000, at, at / 1_000)
          : feedAltitude(
              35_000,
              at,
              at / 1_000 + 1,
              alternate ? { feedId: 'feed-2' } : {},
            );
      result = gateLocalAdsbAltitude(record, gate, at);
    }
    assert.equal(result.altitudeFt, 35_000, secondSource);
  }
});

test("a newly accepted reference clears every receiver's pending recovery", () => {
  const gate = createLocalAdsbAltitudeGate();
  gateLocalAdsbAltitude(feedAltitude(108_800, 0, 1), gate, 0);
  gateLocalAdsbAltitude(feedAltitude(35_000, 1_000, 2), gate, 1_000);
  gateLocalAdsbAltitude(feedAltitude(35_000, 3_000, 3), gate, 3_000);
  for (const at of [4_000, 4_500, 5_000])
    gateLocalAdsbAltitude(browserAltitude(80_000, at, at), gate, at);
  const result = gateLocalAdsbAltitude(
    feedAltitude(35_000, 6_000, 4),
    gate,
    6_000,
  );
  assert.equal(
    result.altitudeFt,
    80_000,
    'old votes cannot re-anchor against the new reference',
  );
});

test('a feed wall-clock rollback judges values and starts a fresh recovery window', () => {
  const gate = createLocalAdsbAltitudeGate();
  gateLocalAdsbAltitude(feedAltitude(35_000, 60_000, 100), gate, 60_000);
  const descent = gateLocalAdsbAltitude(
    feedAltitude(33_750, 40_000, 101),
    gate,
    70_000,
  );
  assert.equal(
    descent.altitudeFt,
    33_750,
    'a clock step cannot freeze a plausible descent',
  );
  assert.equal(descent.altitudeQuality, 'feed-estimate');
  for (const [raw, at, count] of [
    [41_000, 71_000, 102],
    [43_000, 73_000, 103],
  ])
    gateLocalAdsbAltitude(feedAltitude(108_800, raw, count), gate, at);
  let result = gateLocalAdsbAltitude(
    feedAltitude(108_800, 20_000, 104),
    gate,
    76_000,
  );
  assert.equal(
    result.altitudeFt,
    33_750,
    'rollback does not reuse the old recovery window',
  );
  result = gateLocalAdsbAltitude(
    feedAltitude(108_800, 22_000, 105),
    gate,
    78_000,
  );
  assert.equal(result.altitudeFt, 33_750);
  result = gateLocalAdsbAltitude(
    feedAltitude(108_800, 25_000, 106),
    gate,
    81_000,
  );
  assert.equal(result.altitudeQuality, 'inferred-reanchor');
});

test('held values keep the accepted measurement time and source; ground/missing clears claims', () => {
  const gate = createLocalAdsbAltitudeGate();
  gateLocalAdsbAltitude(browserAltitude(35_000, 100, 1), gate, 100);
  const held = gateLocalAdsbAltitude(
    feedAltitude(108_800, 1_000, 1),
    gate,
    1_000,
  );
  assert.equal(held.source, 'feed', 'position source remains the feed');
  assert.equal(held.altitudeSource, 'webusb');
  assert.equal(held.altitudeObservedAt, 100);
  assert.equal(held.altitudeQuality, 'held-after-rejection');
  for (const extra of [
    { altitudeFt: null },
    { altitudeFt: 0, onGround: true },
  ]) {
    const result = gateLocalAdsbAltitude(
      feedAltitude(108_800, 2_000, 2, extra),
      gate,
      2_000,
    );
    assert.equal(result.altitudeQuality, null);
    assert.equal(result.altitudeSource, null);
    assert.equal(result.altitudeObservedAt, null);
  }
  assert.equal(gate.accepted, null, 'ground resets the airborne reference');
  const takeoff = gateLocalAdsbAltitude(
    browserAltitude(5_700, 3_000, 2),
    gate,
    3_000,
  );
  assert.equal(takeoff.altitudeFt, 5_700);
});

test('feed recovery needs five seconds, three advancing snapshots and aircraft activity', () => {
  const gate = createLocalAdsbAltitudeGate();
  let result = gateLocalAdsbAltitude(feedAltitude(108_800, 0, 1), gate, 0);
  assert.equal(result.altitudeQuality, 'feed-estimate');
  for (const [at, count] of [
    [1_000, 2],
    [2_000, 3],
    [3_000, 4],
    [5_999, 5],
  ]) {
    result = gateLocalAdsbAltitude(feedAltitude(35_000, at, count), gate, at);
    assert.equal(
      result.altitudeFt,
      108_800,
      'minimum recovery duration has not elapsed',
    );
  }
  result = gateLocalAdsbAltitude(feedAltitude(35_000, 6_000, 6), gate, 6_000);
  assert.equal(result.altitudeFt, 35_000);
  assert.equal(result.altitudeQuality, 'inferred-reanchor');
  assert.equal(
    result.altitudeObservedAt,
    null,
    'feed has no measurement timestamp',
  );
  assert.equal(result.altitudeSource, 'feed');
  assert.equal(gate.rejected, 1, 'retained altitude was refused once');
  result = gateLocalAdsbAltitude(feedAltitude(35_025, 7_000, 7), gate, 7_000);
  assert.equal(
    result.altitudeQuality,
    'feed-estimate',
    'a changed plausible value is an estimate',
  );

  const sparse = createLocalAdsbAltitudeGate();
  gateLocalAdsbAltitude(feedAltitude(108_800, 0, 1), sparse, 0);
  gateLocalAdsbAltitude(feedAltitude(35_000, 1_000, 2), sparse, 1_000);
  result = gateLocalAdsbAltitude(feedAltitude(35_000, 7_000, 3), sparse, 7_000);
  assert.equal(
    result.altitudeFt,
    108_800,
    'two snapshots do not suffice even after five seconds',
  );
  result = gateLocalAdsbAltitude(feedAltitude(35_000, 8_000, 4), sparse, 8_000);
  assert.equal(result.altitudeFt, 35_000);
});

test('cached feed snapshots, message-free snapshots and missing metadata cannot infer recovery', () => {
  for (const mode of ['cached', 'no-messages', 'no-snapshot', 'no-id']) {
    const gate = createLocalAdsbAltitudeGate();
    gateLocalAdsbAltitude(feedAltitude(35_000, 0, 1), gate, 0);
    for (const at of [1_000, 2_000, 4_000, 7_000, 20_000]) {
      const extra =
        mode === 'no-snapshot'
          ? { feedSnapshotAt: null }
          : mode === 'no-id'
            ? { feedId: null }
            : {};
      const record = feedAltitude(
        108_800,
        mode === 'cached' ? 1_000 : at,
        mode === 'cached' || mode === 'no-messages' ? 2 : at,
        extra,
      );
      const result = gateLocalAdsbAltitude(
        { ...record, lastMessageAt: at },
        gate,
        at,
      );
      assert.equal(result.altitudeFt, 35_000, mode);
    }
    assert.equal(gate.rejected, 1, mode);
  }
});

test('incoherent feed candidates, counter reset and clock regression restart recovery', () => {
  for (const mode of ['incoherent', 'counter-reset', 'clock-regression']) {
    const gate = createLocalAdsbAltitudeGate();
    gateLocalAdsbAltitude(feedAltitude(35_000, 0, 1), gate, 0);
    gateLocalAdsbAltitude(feedAltitude(108_800, 1_000, 2), gate, 1_000);
    gateLocalAdsbAltitude(feedAltitude(108_800, 3_000, 3), gate, 3_000);
    const broken =
      mode === 'incoherent'
        ? feedAltitude(80_000, 6_000, 4)
        : mode === 'counter-reset'
          ? feedAltitude(108_800, 6_000, 1)
          : feedAltitude(108_800, 2_000, 4);
    let result = gateLocalAdsbAltitude(broken, gate, 6_000);
    assert.equal(result.altitudeFt, 35_000, mode);
    result = gateLocalAdsbAltitude(
      feedAltitude(broken.altitudeFt, 7_000, 5),
      gate,
      7_000,
    );
    assert.equal(
      result.altitudeFt,
      35_000,
      `${mode}: no old recovery duration/votes`,
    );
  }
});

test('feed altitude changes keep a real gap allowance but retained values cannot age it without bound', () => {
  const gate = createLocalAdsbAltitudeGate();
  gateLocalAdsbAltitude(feedAltitude(30_000, 0, 1), gate, 0);
  for (const at of [1_000, 5_000, 9_000])
    gateLocalAdsbAltitude(feedAltitude(30_000, at, at), gate, at);
  const climb = gateLocalAdsbAltitude(
    feedAltitude(32_000, 10_000, 20),
    gate,
    10_000,
  );
  assert.equal(
    climb.altitudeFt,
    32_000,
    'non-altitude activity did not shrink the altitude gap',
  );
  for (let at = 20_000; at <= 1_800_000; at += 20_000)
    gateLocalAdsbAltitude(feedAltitude(32_000, at, at), gate, at);
  const spike = gateLocalAdsbAltitude(
    feedAltitude(108_800, 1_801_000, 1_801_000),
    gate,
    1_801_000,
  );
  assert.equal(
    spike.altitudeFt,
    32_000,
    'fresh positions cannot grow an unlimited altitude allowance',
  );
  assert.equal(spike.altitudeQuality, 'held-after-rejection');
  const balloon = gateLocalAdsbAltitude(
    feedAltitude(120_000, 0, 1),
    createLocalAdsbAltitudeGate(),
    0,
  );
  assert.equal(
    balloon.altitudeFt,
    120_000,
    'this is a relative filter with no absolute ceiling',
  );
});

test('CRC-valid decoder frames retain one refused altitude through interleaved message types', () => {
  const tracks = new Map();
  const gate = createLocalAdsbAltitudeGate();
  const hex = (s) => Uint8Array.from(s.match(/../g), (p) => parseInt(p, 16));
  const parity = (bytes) => {
    bytes.fill(0, 11);
    const crc = modeSChecksum(bytes.slice(0, 11));
    bytes[11] = crc >>> 16;
    bytes[12] = (crc >>> 8) & 0xff;
    bytes[13] = crc & 0xff;
    assert.equal(modeSChecksum(bytes), 0);
    return bytes;
  };
  const position = hex('8D40621D58C382D690C8AC2863A7');
  const low = position.slice();
  const n = (2_000 + 1_000) / 25;
  const field = ((n >> 4) << 5) | 0x10 | (n & 0xf);
  low[5] = field >> 4;
  low[6] = ((field & 0xf) << 4) | (low[6] & 0xf);
  const id = parity(hex('8D40621D202CC371C32CE0000000'));
  const velocity = parity(hex('8D40621D99440994083817000000'));
  const apply = (bytes, at) =>
    gateLocalAdsbAltitude(
      recordFromDecoderTrack(
        updateAircraftTrack(
          tracks,
          decodeAdsbMessage(bytes, { receivedAt: at }),
        ),
      ),
      gate,
      at,
    );
  apply(position, 0);
  let result = apply(parity(low), 1_000);
  for (const [bytes, at] of [
    [id, 2_000],
    [velocity, 3_000],
    [id, 4_000],
  ]) {
    result = apply(bytes, at);
    assert.equal(result.altitudeFt, 38_000);
    assert.equal(result.altitudeObservedAt, 0);
  }
  assert.equal(gate.rejected, 1);
  assert.equal(result.altitudeQuality, 'held-after-rejection');
  assert.equal(apply(position, 5_000).altitudeQuality, 'accepted');
});
