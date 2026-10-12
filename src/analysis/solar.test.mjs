import test from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedInstant,
  wallTime,
  calculateSun,
  shadowEndpoint,
} from './solar.js';
test('IANA conversion preserves selected wall time and handles DST gaps/folds honestly', () => {
  assert.equal(
    zonedInstant('2026-07-01T12:00', 'America/New_York').date.toISOString(),
    '2026-07-01T16:00:00.000Z',
  );
  assert.throws(
    () => zonedInstant('2026-03-08T02:30', 'America/New_York'),
    /does not exist/,
  );
  const folded = zonedInstant('2026-11-01T01:30', 'America/New_York');
  assert.equal(folded.date.toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(folded.ambiguous, true);
  assert.equal(
    wallTime(new Date('2026-07-01T16:00Z'), 'America/New_York'),
    '2026-07-01T12:00',
  );
  assert.throws(() => zonedInstant('2026-02-30T12:00', 'UTC'));
  assert.throws(() => zonedInstant('2026-07-01T12:00', 'Bad/Zone'));
});
test('north-clockwise degree convention and night/polar behavior stay explicit', () => {
  const p = {
    lat: 51.5,
    lon: 0,
    value: '2026-06-21T12:00',
    timeZone: 'UTC',
    heightM: 2,
  };
  const r = calculateSun(p);
  assert.ok(r.altitudeDeg > 60 && r.altitudeDeg < 65);
  assert.ok(r.azimuthDeg > 170 && r.azimuthDeg < 190);
  assert.ok(r.shadowBearingDeg < 10 || r.shadowBearingDeg > 350);
  assert.ok(r.sunrise < r.instant && r.sunset > r.instant);
  assert.ok(r.shadowLengthM > 0 && r.shadowLengthM < 2);
  const night = calculateSun({ ...p, value: '2026-06-21T00:00' });
  assert.equal(night.shadowLengthM, null);
  const polar = calculateSun({ ...p, lat: 80 });
  assert.equal(polar.sunrise, null);
  assert.equal(polar.sunset, null);
  assert.equal(polar.alwaysUp, true);
  assert.throws(() => calculateSun({ ...p, heightM: 201 }));
});
test('approximate sketch bearing sends north/east endpoints in the correct direction', () => {
  const n = shadowEndpoint(0, 0, 0, 1000),
    e = shadowEndpoint(0, 0, 90, 1000);
  assert.ok(n.lat > 0 && Math.abs(n.lon) < 1e-6);
  assert.ok(e.lon > 0 && Math.abs(e.lat) < 1e-6);
});
