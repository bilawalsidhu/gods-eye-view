import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LOCAL_ADSB_MESSAGE_STALE_MS,
  LOCAL_ADSB_POSITION_STALE_MS,
  LOCAL_ADSB_REFERENCE_MAX_AGE_MS,
  createLocalAdsbAltitudeGate,
  gateLocalAdsbAltitude,
  localAdsbAltitudeCeilingFt,
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

/** Feed one aircraft's reports, `[seconds, altitudeFt, extra]`, through a gate. */
function gateReports(reports) {
  const gate = createLocalAdsbAltitudeGate();
  const altitudes = reports.map(
    ([seconds, altitudeFt, extra = {}]) =>
      gateLocalAdsbAltitude(
        {
          icao: 'abc123',
          lastMessageAt: seconds * 1_000,
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

test('only the fixed-wing weight categories A1–A5 have an altitude ceiling', () => {
  for (const category of ['A1', 'A2', 'A3', 'A4', 'a5'])
    assert.equal(localAdsbAltitudeCeilingFt(category), 60_000, category);
  // High performance, rotorcraft, gliders, balloons, UAVs, space: none, and
  // an unknown category is never assumed to have one.
  for (const category of ['A6', 'A7', 'B1', 'B2', 'B6', 'B7', null, 'ZZ'])
    assert.equal(localAdsbAltitudeCeilingFt(category), null, category);
});

const A3 = { category: 'A3' };

test('a fixed-wing altitude above the ceiling is unknown until a real one arrives', () => {
  // Refused on the first frame, with nothing earlier to hold. The vertical
  // rate check alone would have drawn it at 108,800 ft for about 1.5 s.
  assert.deepEqual(
    gateReports([
      [0, 108_800, A3],
      [0.5, 35_000, A3],
    ]),
    { altitudes: [null, 35_000], rejected: 1 },
  );
});

test('a feed stuck on an impossible altitude never makes it the reference', () => {
  // Three refusals re-anchor a rate-refused altitude. One above the ceiling
  // must not count toward that, however often the feed relays it.
  assert.deepEqual(
    gateReports([
      [0, 35_000, A3],
      [1, 108_800, A3],
      [2, 108_800, A3],
      [3, 108_800, A3],
      [4, 108_800, A3],
    ]),
    { altitudes: [35_000, 35_000, 35_000, 35_000, 35_000], rejected: 4 },
  );
});

test('a reference taken before the category was known is dropped once it is', () => {
  // The identification message carrying the category often arrives seconds
  // after the first altitude.
  assert.deepEqual(
    gateReports([
      [0, 108_800],
      [0.5, 35_000, A3],
    ]),
    { altitudes: [108_800, 35_000], rejected: 0 },
  );
});

test('categories without a ceiling keep altitudes a fixed-wing aircraft could not reach', () => {
  assert.deepEqual(
    gateReports([
      [0, 110_000, { category: 'B2' }],
      [1, 110_050, { category: 'B2' }],
    ]),
    { altitudes: [110_000, 110_050], rejected: 0 },
  );
  assert.deepEqual(gateReports([[0, 51_000, A3]]), {
    altitudes: [51_000],
    rejected: 0,
  });
  // The ceiling itself is reachable; one 25 ft step above it is not.
  assert.deepEqual(gateReports([[0, 60_000, A3]]), {
    altitudes: [60_000],
    rejected: 0,
  });
  assert.deepEqual(gateReports([[0, 60_025, A3]]), {
    altitudes: [null],
    rejected: 1,
  });
});
