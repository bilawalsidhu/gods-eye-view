import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  addSeconds,
  cloneJulian,
  compareJulian,
  computeTaiMinusUtc,
  julianFromEpochMs,
  julianLessThan,
  julianLessThanOrEquals,
  julianNow,
  julianToEpochMs,
  secondsDifference,
  totalDays,
} from './julian.js';

const { JulianDate } = Cesium;

// Leap-second edges, the noon split, a far past and present-day instants.
const TIMES = [
  0,
  Date.UTC(1971, 11, 31, 23, 59, 59, 999),
  Date.UTC(1972, 0, 1),
  Date.UTC(2016, 11, 31, 23, 59, 59, 500),
  Date.UTC(2017, 0, 1),
  Date.UTC(2017, 0, 1, 0, 0, 0, 1),
  Date.UTC(2026, 10, 7, 11, 59, 59, 999),
  Date.UTC(2026, 10, 7, 12),
  Date.UTC(2026, 10, 7, 12, 0, 0, 1),
  Date.UTC(2026, 10, 7, 18, 31, 7, 123),
  Date.UTC(1950, 5, 1, 3, 4, 5, 6),
  1_789_123_456_789,
];

const parts = (date) => [date.dayNumber, date.secondsOfDay];

test('dates from epoch ms are JulianDate.fromDate, bit for bit', () => {
  for (const ms of TIMES) {
    const theirs = JulianDate.fromDate(new Date(ms));
    assert.deepEqual(parts(julianFromEpochMs(ms)), parts(theirs), `${ms}`);
    const result = {};
    assert.equal(julianFromEpochMs(ms, result), result);
  }
});

test('epoch ms back from a date is JulianDate.toDate, its leap seconds included', () => {
  for (const ms of TIMES) {
    const date = JulianDate.fromDate(new Date(ms));
    assert.equal(julianToEpochMs(date), JulianDate.toDate(date).getTime());
    // A round trip is Cesium's too, sub-millisecond rounding included.
    assert.equal(
      julianToEpochMs(julianFromEpochMs(ms)),
      JulianDate.toDate(date).getTime(),
    );
  }
  // Inside the 2016 leap second (TAI 23:59:60 UTC).
  const leap = JulianDate.addSeconds(
    JulianDate.fromDate(new Date(Date.UTC(2017, 0, 1))),
    -0.5,
    new JulianDate(),
  );
  assert.equal(julianToEpochMs(leap), JulianDate.toDate(leap).getTime());
  // Fractional seconds a date carries after arithmetic.
  for (const seconds of [-3.7, -0.0004, 0.25, 1.333, 86399.9]) {
    const date = JulianDate.addSeconds(
      JulianDate.fromDate(new Date(TIMES[9])),
      seconds,
      new JulianDate(),
    );
    assert.equal(julianToEpochMs(date), JulianDate.toDate(date).getTime());
  }
});

test('arithmetic and comparison are JulianDate’s, on either kind of date', () => {
  const a = julianFromEpochMs(TIMES[7]);
  const b = JulianDate.fromDate(new Date(TIMES[9]));
  for (const seconds of [-90000, -1.5, 0, 0.001, 43200, 172800.25]) {
    assert.deepEqual(
      parts(addSeconds(a, seconds)),
      parts(JulianDate.addSeconds(a, seconds, new JulianDate())),
    );
  }
  assert.equal(secondsDifference(b, a), JulianDate.secondsDifference(b, a));
  assert.equal(compareJulian(a, b), JulianDate.compare(a, b));
  assert.equal(julianLessThan(a, b), true);
  assert.equal(julianLessThan(a, a), false);
  assert.equal(julianLessThanOrEquals(a, cloneJulian(a)), true);
  assert.equal(totalDays(a), JulianDate.totalDays(a));
  assert.equal(computeTaiMinusUtc(a), JulianDate.computeTaiMinusUtc(a));
  assert.equal(cloneJulian(undefined), undefined);
  const into = {};
  assert.equal(cloneJulian(a, into), into);
  assert.deepEqual(parts(into), parts(a));
});

test('now is the system time', () => {
  const before = Date.now();
  const now = julianToEpochMs(julianNow());
  // A millisecond's round trip may round down by one, as Cesium's does.
  assert.ok(now >= before - 1 && now <= Date.now());
});
