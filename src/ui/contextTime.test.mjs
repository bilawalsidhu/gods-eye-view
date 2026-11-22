import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clockLine,
  dayLengthMinutes,
  daylightShare,
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

test('the sun: long days north, polar night south, half the Earth lit', () => {
  assert.equal(dayLengthMinutes(80, NOON_UTC), 1440, 'midnight sun');
  assert.equal(dayLengthMinutes(-80, NOON_UTC), 0, 'polar night');
  const equator = dayLengthMinutes(0, NOON_UTC);
  assert.ok(
    equator > 715 && equator < 735,
    `about 12 h at the equator, got ${equator}`,
  );
  const share = daylightShare(NOON_UTC);
  assert.ok(
    share > 0.48 && share < 0.53,
    `about half the Earth is lit, got ${share}`,
  );
});

test('the time line reads local and UTC, or UTC alone until the zone is known', () => {
  const at = Date.UTC(2026, 10, 19, 16, 14);
  assert.equal(
    clockLine({ utcOffsetSeconds: -6 * 3600 }, at),
    '10:14 local, 16:14 UTC',
  );
  assert.equal(clockLine(null, at), '16:14 UTC');
});
