import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clockLine,
  dayLengthMinutes,
  localClock,
  utcClock,
} from './contextTime.js';

const NOON_UTC = Date.UTC(2026, 5, 21, 12, 0);

test('local time comes from the zone a weather reading names, else its offset, else nothing', () => {
  assert.equal(utcClock(NOON_UTC), '12:00');
  assert.equal(localClock({ timeZone: 'America/Chicago' }, NOON_UTC), '07:00');
  assert.equal(
    localClock({ timeZone: 'Not/AZone', utcOffsetSeconds: 19800 }, NOON_UTC),
    '17:30',
  );
  assert.equal(localClock({ utcOffsetSeconds: -18000 }, NOON_UTC), '07:00');
  assert.equal(localClock(null, NOON_UTC), null);
  assert.equal(localClock({}, NOON_UTC), null);
});

test('summer has long days in the north and polar night in the south', () => {
  assert.equal(dayLengthMinutes(80, NOON_UTC), 1440, 'midnight sun');
  assert.equal(dayLengthMinutes(-80, NOON_UTC), 0, 'polar night');
  const equator = dayLengthMinutes(0, NOON_UTC);
  assert.ok(
    equator > 715 && equator < 735,
    `about 12 h at the equator, got ${equator}`,
  );
});

test('Tromsø keeps one daylight duration for its civil date', () => {
  const site = { lon: 18.96, zone: { timeZone: 'Europe/Oslo' } };
  const duration = (iso) => dayLengthMinutes(69.65, Date.parse(iso), site);
  const morning = duration('2026-11-26T23:00:00Z');
  assert.equal(duration('2026-11-27T11:00:00Z'), morning);
  assert.equal(duration('2026-11-27T22:59:00Z'), morning);
  assert.ok(morning > 0 && morning < 35);
  assert.equal(duration('2026-11-27T23:00:00Z'), 0);
});

test('the time line reads local and UTC, or UTC alone until the zone is known', () => {
  const at = Date.UTC(2026, 10, 19, 16, 14);
  assert.equal(
    clockLine({ utcOffsetSeconds: -6 * 3600 }, at),
    '10:14 local, 16:14 UTC',
  );
  assert.equal(clockLine(null, at), '16:14 UTC');
});
