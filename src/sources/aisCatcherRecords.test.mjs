import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAisCatcherShips } from './aisCatcherRecords.js';

// Field names follow AIS-catcher's public ships.json documentation. MMSIs are
// sequential placeholders and the position is open ocean.
const NOW = 1_800_000_000_000;
const SHIP = Object.freeze({
  mmsi: 200000001,
  shipclass: 0,
  validated: 1,
  lat: 30.5,
  lon: -40.5,
  shipname: 'TEST VESSEL',
  last_signal: 2,
  speed: 9.4,
  cog: 77,
  heading: 75,
  shiptype: 70,
  destination: 'NOWHERE',
});

const run = (ships) => normalizeAisCatcherShips({ ships }, NOW);

test('a validated vessel keeps its fields and is dated by last_signal', () => {
  const { records, dropped, newestSignalAt } = run([SHIP]);
  assert.equal(dropped, 0);
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.id, 'local-ais:200000001');
  assert.equal(record.lastSeenAt, NOW - 2000);
  assert.equal(newestSignalAt, NOW - 2000);
  assert.equal(record.validated, true);
  assert.equal(record.shipType, 70);
  assert.equal(record.source, 'local-ais');
});

test('validated -1 is rejected; 0 and unrecognised values stay but are unvalidated', () => {
  const { records, dropped } = run([
    { ...SHIP, mmsi: 200000001, validated: -1 },
    { ...SHIP, mmsi: 200000002, validated: 0 },
    { ...SHIP, mmsi: 200000003, validated: 2 },
    { ...SHIP, mmsi: 200000004, validated: 'no' },
    { ...SHIP, mmsi: 200000005, validated: undefined },
  ]);
  assert.equal(dropped, 1);
  assert.deepEqual(
    records.map((r) => [r.mmsi, r.validated]),
    [
      ['200000002', false],
      ['200000003', false],
      ['200000004', false],
      ['200000005', false],
    ],
  );
});

test('ship type 0 (not available) is unknown, not a type', () => {
  const [record] = run([{ ...SHIP, shiptype: 0 }]).records;
  assert.equal(record.shipType, null);
});

test('absent or not-available measurements stay null, never zero', () => {
  const [record] = run([
    { ...SHIP, speed: 102.3, cog: 360, heading: 511, shiptype: undefined },
  ]).records;
  assert.equal(record.speed, null);
  assert.equal(record.course, null);
  assert.equal(record.heading, null);
  assert.equal(record.shipType, null);
  const [bare] = run([
    { ...SHIP, speed: null, cog: '', heading: undefined },
  ]).records;
  assert.equal(bare.speed, null);
  assert.equal(bare.course, null);
  assert.equal(bare.heading, null);
});

test('0,0, unavailable-position sentinels and bad coordinates are refused and counted', () => {
  const { records, dropped } = run([
    { ...SHIP, mmsi: 200000001, lat: 0, lon: 0 },
    { ...SHIP, mmsi: 200000002, lat: 91, lon: 181 },
    { ...SHIP, mmsi: 200000003, lat: null },
    { ...SHIP, mmsi: 200000004, lon: 'x' },
    { ...SHIP, mmsi: 200000005, lat: 0, lon: 12 },
  ]);
  assert.deepEqual(
    records.map((r) => r.mmsi),
    ['200000005'],
  );
  assert.equal(dropped, 4);
});

test('bad MMSIs, non-vessel classes and non-object rows are counted as dropped', () => {
  const { records, dropped, rejected, filtered } = run([
    SHIP,
    { ...SHIP, mmsi: 'garbage' },
    { ...SHIP, mmsi: 12345 },
    { ...SHIP, mmsi: 200000002, shipclass: 9 },
    { ...SHIP, mmsi: 200000003, shipclass: 13 },
    { ...SHIP, mmsi: 200000004, shipclass: 1.5 },
    null,
    'text',
    [],
  ]);
  // The class 13 row under an ordinary MMSI is not a beacon: filtered.
  assert.equal(records.length, 1);
  assert.equal(dropped, 8);
  // Classes 9 to 13 are left out by design: filtered, not rejected data.
  assert.equal(filtered, 2);
  assert.equal(rejected, 6);
});

test('a receiver that hears only base stations or aids to navigation has nothing rejected', () => {
  const result = run([
    { ...SHIP, mmsi: 200000002, shipclass: 11 },
    { ...SHIP, mmsi: 200000003, shipclass: 12 },
  ]);
  assert.equal(result.records.length, 0);
  assert.equal(result.filtered, 2);
  assert.equal(result.rejected, 0);
  // The receiver is alive: its filtered rows date its last activity.
  assert.equal(result.newestSignalAt, NOW - 2000);
});

test('classes 9 to 12 are filtered by design and still date the receiver', () => {
  for (const shipClass of [9, 10, 11, 12, 14, 27]) {
    const result = run([
      { ...SHIP, mmsi: 200000002, shipclass: shipClass, last_signal: 90 },
    ]);
    assert.equal(result.filtered, 1, `class ${shipClass}`);
    assert.equal(result.records.length, 0);
    assert.equal(result.rejected, 0);
    assert.equal(result.newestSignalAt, NOW - 90_000);
  }
  // A filtered row with no usable age cannot date anything.
  assert.equal(
    run([{ ...SHIP, mmsi: 200000002, shipclass: 9, last_signal: null }])
      .newestSignalAt,
    null,
  );
});

test('a refused row counts as rejected only while its last_signal is 600 s or less, or unknown', () => {
  const refused = (extra) => run([{ ...SHIP, validated: -1, ...extra }]);
  assert.equal(refused({ last_signal: 2 }).rejected, 1);
  assert.equal(refused({ last_signal: 600 }).rejected, 1);
  assert.equal(refused({ last_signal: null }).rejected, 1);
  assert.equal(refused({ last_signal: 601 }).rejected, 0);
  assert.equal(refused({ last_signal: 3000 }).rejected, 0);
  // An old malformed row is old, not fresh bad data.
  assert.equal(run([{ ...SHIP, lat: 'x', last_signal: 3000 }]).rejected, 0);
  // Still dropped either way.
  assert.equal(refused({ last_signal: 3000 }).dropped, 1);
});

test('the 600 s age edge: 600 is kept, 601 is dropped but still dates the receiver', () => {
  const edge = run([{ ...SHIP, last_signal: 600 }]);
  assert.equal(edge.records.length, 1);
  assert.equal(edge.records[0].lastSeenAt, NOW - 600_000);
  const over = run([{ ...SHIP, last_signal: 601 }]);
  assert.equal(over.records.length, 0);
  assert.equal(over.dropped, 1);
  assert.equal(over.newestSignalAt, NOW - 601_000);
  assert.equal(run([{ ...SHIP, last_signal: -1 }]).records.length, 0);
  assert.equal(run([{ ...SHIP, last_signal: null }]).records.length, 0);
});

test('an empty or malformed list gives nothing and no data age', () => {
  for (const payload of [{ ships: [] }, {}, null, { ships: 'x' }]) {
    assert.deepEqual(normalizeAisCatcherShips(payload, NOW), {
      records: [],
      dropped: 0,
      rejected: 0,
      filtered: 0,
      newestSignalAt: null,
    });
  }
});

test('the newest duplicate MMSI wins and the other row is counted', () => {
  const { records, dropped } = run([
    { ...SHIP, last_signal: 30, lat: 31 },
    { ...SHIP, last_signal: 5, lat: 32 },
    { ...SHIP, last_signal: 90, lat: 33 },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].lat, 32);
  assert.equal(dropped, 2);
});

test('the approximate flag is kept, and the station block is never read', () => {
  const { records } = normalizeAisCatcherShips(
    { station: { lat: 1.5, lon: 2.5 }, ships: [{ ...SHIP, approx: true }] },
    NOW,
  );
  assert.equal(records[0].approx, true);
  assert.ok(!JSON.stringify(records).includes('1.5'));
});

test('control characters are stripped from names and destinations', () => {
  const [record] = run([
    { ...SHIP, shipname: 'A\u0000B\nC', destination: 'X\u001fY' },
  ]).records;
  assert.equal(record.name, 'A B C');
  assert.equal(record.destination, 'X Y');
});

const BEACON = Object.freeze({
  ...SHIP,
  mmsi: 970000001,
  shipclass: 13,
  shipname: 'TEST SART',
});

test('beacons: only the reserved MMSI blocks are beacons, never vessels', () => {
  const kinds = (ships) => run(ships).records.map((r) => r.beaconType);
  assert.deepEqual(kinds([SHIP]), [null], 'a vessel has no beacon type');
  assert.deepEqual(kinds([BEACON]), ['sart']);
  assert.deepEqual(kinds([{ ...BEACON, mmsi: 972000001 }]), ['mob']);
  assert.deepEqual(kinds([{ ...BEACON, mmsi: 974000001 }]), ['epirb']);
  // The MMSI block decides even when the class is an ordinary vessel class.
  assert.deepEqual(kinds([{ ...BEACON, shipclass: 0 }]), ['sart']);
  assert.deepEqual(kinds([{ ...BEACON, shipclass: null }]), ['sart']);
  // Class 13 under an ordinary MMSI is not a beacon: it is filtered.
  assert.deepEqual(kinds([{ ...BEACON, mmsi: 200000009 }]), []);
  // 971, 973 and 975 are not beacon blocks.
  for (const mmsi of [971000001, 973000001, 975000001])
    assert.deepEqual(kinds([{ ...SHIP, mmsi }]), [null], String(mmsi));
});

// AIS-catcher gives ship class 13 to every MMSI from 970000000 to 980000000,
// so the class cannot tell a beacon from any other device in that range.
const catcher = (mmsi) => ({ ...SHIP, mmsi, shipclass: 13 });

test('real AIS-catcher shape: only the 970, 972 and 974 blocks count as beacons', () => {
  const mmsis = [
    970000001, 971000001, 972000001, 973000001, 974000001, 975000001, 976000001,
    977000001, 978000001, 979000001, 980000000,
  ];
  const result = run(mmsis.map(catcher));
  assert.deepEqual(
    result.records.map((r) => [r.mmsi, r.beaconType]),
    [
      ['970000001', 'sart'],
      ['972000001', 'mob'],
      ['974000001', 'epirb'],
    ],
  );
  assert.equal(result.records.length, 3);
  assert.equal(result.filtered, 8, 'the other 8 are filtered, not drawn');
  assert.equal(result.dropped, 8);
  assert.equal(result.rejected, 0);
  // A filtered class-13 row still dates the receiver.
  const only = run([catcher(971000001)]);
  assert.equal(only.records.length, 0);
  assert.equal(only.newestSignalAt, NOW - 2000);
});

test('a beacon is kept at exactly 600 s and dropped just after', () => {
  assert.equal(run([{ ...BEACON, last_signal: 600 }]).records.length, 1);
  assert.equal(run([{ ...BEACON, last_signal: 600.001 }]).records.length, 0);
  assert.equal(run([{ ...SHIP, last_signal: 600 }]).records.length, 1);
});

test('a beacon is a record, not a filtered class, and carries its own fields', () => {
  const result = run([BEACON]);
  assert.equal(result.records.length, 1);
  assert.equal(result.filtered, 0);
  assert.equal(result.dropped, 0);
  const [record] = result.records;
  assert.equal(record.id, 'local-ais:970000001');
  assert.equal(record.lat, 30.5);
  assert.equal(record.validated, true);
  assert.equal(record.approx, false);
  assert.equal(record.lastSeenAt, NOW - 2000);
});

test('a beacon follows the same refusal, age and position rules as a vessel', () => {
  const none = (extra) => run([{ ...BEACON, ...extra }]).records.length;
  assert.equal(none({ validated: -1 }), 0);
  assert.equal(none({ lat: 0, lon: 0 }), 0);
  assert.equal(none({ lat: 91 }), 0);
  assert.equal(none({ last_signal: 601 }), 0);
  assert.equal(none({ last_signal: null }), 0);
  assert.equal(none({ shipclass: -1 }), 0);
  assert.equal(none({ shipclass: 1.5 }), 0);
  assert.equal(none({ mmsi: '97000001' }), 0);
  // Not validated, and approximate, are kept and flagged like a vessel's.
  const pending = run([{ ...BEACON, validated: 0 }]).records[0];
  assert.equal(pending.validated, false);
  assert.equal(run([{ ...BEACON, approx: 1 }]).records[0].approx, true);
  // A refused beacon is rejected data while recent.
  assert.equal(run([{ ...BEACON, validated: -1 }]).rejected, 1);
});

test('a beacon next to a vessel is its own record and dates the receiver', () => {
  const result = run([BEACON, SHIP]);
  assert.deepEqual(
    result.records.map((r) => [r.mmsi, r.beaconType]),
    [
      ['970000001', 'sart'],
      ['200000001', null],
    ],
  );
  assert.equal(result.newestSignalAt, NOW - 2000);
});

test('a receiver that holds only refused rows is dated by the newest of them', () => {
  const refused = run([
    { ...SHIP, validated: -1, last_signal: 3000 },
    { ...SHIP, mmsi: 200000002, lat: 0, lon: 0, last_signal: 90 },
    { ...SHIP, mmsi: 200000003, validated: -1, last_signal: 700 },
  ]);
  assert.equal(refused.records.length, 0);
  assert.equal(refused.newestSignalAt, NOW - 90_000, 'alive, not never');
  assert.equal(refused.rejected, 1, 'only the recent refusal is rejected data');
  // A refused row with no usable age cannot date anything.
  assert.equal(
    run([{ ...SHIP, validated: -1, last_signal: null }]).newestSignalAt,
    null,
  );
});
