import assert from 'node:assert/strict';
import test from 'node:test';
import * as beacons from './ncdxfBeacons.js';
import {
  IBP_BANDS,
  IBP_BEACONS,
  ibpBeacon,
  ibpBeaconIndexOnBand,
  ibpPowerStep,
  ibpScheduleFor,
  ibpSlot,
  isIbpOffAir,
  setIbpOffAir,
} from './ncdxfBeacons.js';

const CYCLE_START = Date.parse('2026-09-12T12:03:00.000Z'); // minute % 3 === 0 → slot 0

function byBand(nowMs) {
  return Object.fromEntries(ibpSlot(nowMs).byBand.map((row) => [row.khz, row.call]));
}

test('the beacon table has the 18 IBP stations in schedule order and five bands', () => {
  assert.equal(IBP_BEACONS.length, 18);
  assert.deepEqual(IBP_BEACONS.map((row) => row.call), [
    '4U1UN', 'VE8AT', 'W6WX', 'KH6RS', 'ZL6B', 'VK6RBP', 'JA2IGY', 'RR9O', 'VR2B',
    '4S7B', 'ZS6DN', '5Z4B', '4X6TU', 'OH2B', 'CS3B', 'LU4AA', 'OA4B', 'YV5B',
  ]);
  for (const row of IBP_BEACONS) {
    assert.ok(Object.isFrozen(row));
    assert.match(row.grid, /^[A-R]{2}\d{2}[a-x]{2}$/);
    assert.ok(Math.abs(row.lat) <= 90 && Math.abs(row.lon) <= 180);
    assert.ok(row.location.length > 3);
  }
  assert.deepEqual(IBP_BANDS.map((row) => row.khz), [14100, 18110, 21150, 24930, 28200]);
  assert.deepEqual(IBP_BANDS.map((row) => row.band), ['20m', '17m', '15m', '12m', '10m']);
  assert.ok(IBP_BANDS.every((row) => /^#[0-9a-f]{6}$/.test(row.color)));
  assert.equal(ibpBeacon('oh2b').call, 'OH2B');
  assert.equal(ibpBeacon('DL0ZZZ'), null);
});

test('slot 0 and slot 1 assignments match the published schedule', () => {
  assert.deepEqual(byBand(CYCLE_START), {
    14100: '4U1UN', 18110: 'YV5B', 21150: 'OA4B', 24930: 'LU4AA', 28200: 'CS3B',
  });
  assert.deepEqual(byBand(CYCLE_START + 10_000), {
    14100: 'VE8AT', 18110: '4U1UN', 21150: 'YV5B', 24930: 'OA4B', 28200: 'LU4AA',
  });
  assert.equal(ibpBeaconIndexOnBand(0, 0), 0);
  assert.equal(ibpBeaconIndexOnBand(0, 1), 17);
  assert.equal(ibpBeaconIndexOnBand(5, 4), 1);
  assert.equal(ibpBeaconIndexOnBand(17, 0), 17);
});

test('slot boundaries: HH:03:00 is slot 0, HH:02:59.9 is slot 17', () => {
  const start = ibpSlot(CYCLE_START);
  assert.equal(start.slot, 0);
  assert.equal(start.secondsIntoCycle, 0);
  assert.equal(start.secondsIntoSlot, 0);
  assert.equal(start.secondsUntilNextSlot, 10);
  const end = ibpSlot(CYCLE_START - 100);
  assert.equal(end.slot, 17);
  assert.ok(Math.abs(end.secondsIntoCycle - 179.9) < 1e-9);
  assert.ok(Math.abs(end.secondsIntoSlot - 9.9) < 1e-9);
  assert.equal(end.byBand[0].call, 'YV5B', 'slot 17 on 14100 is the last beacon');
  const sixMinutesLater = ibpSlot(CYCLE_START + 6 * 60_000 + 25_500);
  assert.equal(sixMinutesLater.slot, 2, 'the cycle repeats every 3 minutes');
  assert.ok(Math.abs(sixMinutesLater.secondsIntoSlot - 5.5) < 1e-9);
  assert.equal(ibpSlot(Date.parse('2026-09-12T12:04:00Z')).slot, 6, 'HH:04:00 is 60 s in → slot 6');
  assert.equal(ibpSlot(Date.parse('2026-09-12T12:05:59.999Z')).slot, 17);
  assert.equal(ibpSlot(Date.parse('2026-09-12T12:06:00.000Z')).slot, 0);
});

test('powerStep tracks the callsign then the four dashes inside a slot', () => {
  assert.equal(ibpPowerStep(0), 'call');
  assert.equal(ibpPowerStep(5.99), 'call');
  assert.equal(ibpPowerStep(6), '100W');
  assert.equal(ibpPowerStep(7), '10W');
  assert.equal(ibpPowerStep(8), '1W');
  assert.equal(ibpPowerStep(9), '100mW');
  assert.equal(ibpPowerStep(9.999), '100mW');
  assert.equal(ibpSlot(CYCLE_START + 3_000).byBand[0].powerStep, 'call');
  assert.equal(ibpSlot(CYCLE_START + 6_500).byBand[2].powerStep, '100W');
  assert.equal(ibpSlot(CYCLE_START + 8_200).byBand[4].powerStep, '1W');
  assert.equal(ibpSlot(CYCLE_START + 9_900).byBand[1].powerStep, '100mW');
  assert.equal(ibpSlot(CYCLE_START + 10_000).byBand[0].powerStep, 'call', 'a new slot starts with the callsign');
});

test('byBand rows carry the beacon position and band colour', () => {
  const row = ibpSlot(CYCLE_START).byBand[0];
  assert.equal(row.call, '4U1UN');
  assert.equal(row.band, '20m');
  assert.equal(row.index, 0);
  assert.equal(row.grid, 'FN30as');
  assert.equal(row.lat, 40.75);
  assert.equal(row.lon, -73.97);
  assert.equal(row.location, 'United Nations, New York');
  assert.equal(row.color, IBP_BANDS[0].color);
});

test('ibpScheduleFor counts seconds to each band start and flags the active band', () => {
  const atStart = ibpScheduleFor('4U1UN', CYCLE_START);
  assert.deepEqual(atStart.map((row) => [row.khz, row.secondsUntil, row.active]), [
    [14100, 0, true], [18110, 10, false], [21150, 20, false], [24930, 30, false], [28200, 40, false],
  ]);
  const ve8at = ibpScheduleFor('ve8at', CYCLE_START);
  assert.deepEqual(ve8at.map((row) => row.secondsUntil), [10, 20, 30, 40, 50]);
  assert.ok(ve8at.every((row) => row.active === false));
  const yv5b = ibpScheduleFor('YV5B', CYCLE_START);
  assert.deepEqual(yv5b.map((row) => row.secondsUntil), [170, 0, 10, 20, 30]);
  assert.equal(yv5b[1].active, true, 'YV5B is on 18110 in slot 0');
  const midSlot = ibpScheduleFor('4U1UN', CYCLE_START + 5_000);
  assert.equal(midSlot[0].secondsUntil, 175, 'five seconds into its 14100 slot the next start is 175 s away');
  assert.equal(midSlot[0].active, true);
  assert.equal(midSlot[1].secondsUntil, 5);
  const oh2b = ibpScheduleFor('OH2B', CYCLE_START + 6 * 60_000 + 125_500);
  assert.ok(Math.abs(oh2b[0].secondsUntil - 4.5) < 1e-9, 'fractional seconds are kept (OH2B index 13 starts at 130 s)');
  assert.equal(oh2b[0].active, false);
  assert.deepEqual(ibpScheduleFor('DL0ZZZ', CYCLE_START), []);
  assert.deepEqual(ibpScheduleFor(null, CYCLE_START), []);
});

test('the off-air list is a live binding that setIbpOffAir replaces', () => {
  assert.deepEqual(beacons.IBP_OFF_AIR, ['YV5B']);
  assert.equal(ibpSlot(CYCLE_START).byBand[1].offAir, true, 'YV5B on 18110 in slot 0 is off the air');
  assert.equal(ibpSlot(CYCLE_START).byBand[0].offAir, false);
  assert.equal(isIbpOffAir('yv5b'), true);
  setIbpOffAir(['oh2b', 'CS3B', 'NOT-A-BEACON', 'oh2b']);
  assert.deepEqual(beacons.IBP_OFF_AIR, ['OH2B', 'CS3B'], 'normalized, deduplicated, unknown calls dropped');
  assert.ok(Object.isFrozen(beacons.IBP_OFF_AIR));
  assert.equal(ibpSlot(CYCLE_START).byBand[1].offAir, false);
  assert.equal(ibpSlot(CYCLE_START).byBand[4].offAir, true, 'CS3B on 28200 in slot 0');
  setIbpOffAir([]);
  assert.deepEqual(beacons.IBP_OFF_AIR, []);
  assert.equal(isIbpOffAir('YV5B'), false);
  setIbpOffAir(null);
  assert.deepEqual(beacons.IBP_OFF_AIR, []);
  setIbpOffAir(['YV5B']);
});
