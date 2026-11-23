import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHECKED_FROM_MS,
  CHECKED_TO_MS,
  ephemerisValidity,
  satelliteValidity,
  validityBanners,
} from './skyValidity.js';

const DAY = 86_400_000;
const T = Date.parse('2026-10-12T03:30:00Z');
const age = (newestEpochMs, extra = {}) => ({
  total: 100,
  newestEpochMs,
  stale: 0,
  dropped: 0,
  ...extra,
});

test('ephemeris range: 1976..2076 is silent, outside warns with the year', () => {
  assert.equal(ephemerisValidity(T), null);
  assert.equal(ephemerisValidity(CHECKED_FROM_MS), null);
  assert.equal(ephemerisValidity(CHECKED_TO_MS - 1), null);
  const before = ephemerisValidity(CHECKED_FROM_MS - 1);
  assert.equal(before.level, 'warn');
  assert.match(before.text, /1975/);
  assert.match(
    ephemerisValidity(Date.UTC(2150, 5, 1)).text,
    /2150.*less certain/,
  );
  assert.equal(ephemerisValidity(NaN), null);
});

test('satellite element age (4.5): ok silent, > 7 d warn, > 30 d error (hidden)', () => {
  assert.equal(satelliteValidity(age(T - 2 * DAY), T), null);
  const warn = satelliteValidity(age(T - 10 * DAY, { stale: 40 }), T);
  assert.equal(warn.level, 'warn');
  assert.match(warn.text, /less certain/);
  assert.match(warn.text, /40 older than 7 d greyed/);
  const error = satelliteValidity(age(T + 45 * DAY, { dropped: 100 }), T);
  assert.equal(error.level, 'error');
  assert.match(error.text, /hidden/);
  assert.equal(satelliteValidity(null, T), null);
});

test('banners sorted error > warn', () => {
  const far = Date.UTC(2090, 0, 1);
  const list = validityBanners({
    timeMs: far,
    satAge: age(T),
  });
  assert.deepEqual(
    list.map((b) => `${b.id}:${b.level}`),
    ['satellites:error', 'ephemeris:warn'],
  );
  assert.deepEqual(validityBanners({ timeMs: T, satAge: age(T) }), []);
  assert.deepEqual(validityBanners({ timeMs: T }), []);
});
