import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSondehubBalloon, normalizeSondehubResponse } from './sondehubFallback.js';

test('normalizes a SondeHub telemetry record and reads ascent phase from vel_v', () => {
  const ascending = normalizeSondehubBalloon({
    serial: 'X4523021',
    lat: 45.90516,
    lon: 17.08161,
    alt: 909.289,
    heading: 246.98291,
    vel_h: 2.52159,
    vel_v: 5.1,
    manufacturer: 'Vaisala',
    type: 'RS41',
    subtype: 'RS41-SG',
    frequency: 405.3,
    temp: 19,
    uploader_callsign: 'HA3HJ-13',
    datetime: '2026-09-01T13:05:56.000Z',
  });
  assert.equal(ascending.serial, 'X4523021');
  assert.equal(ascending.lat, 45.90516);
  assert.equal(ascending.altitudeM, 909.289);
  assert.equal(ascending.phase, 'ascending');
  assert.equal(ascending.type, 'RS41');
  assert.equal(ascending.timeMs, Date.parse('2026-09-01T13:05:56.000Z'));

  const descending = normalizeSondehubBalloon({
    serial: 'X1', lat: 1, lon: 1, vel_v: -14.4,
  });
  assert.equal(descending.phase, 'descending');

  // A post-burst freefall briefly reads a small negative vel_v before the
  // parachute bites — still functionally "still ascending" from a user's
  // point of view, so the -1 m/s guard band keeps it out of "descending".
  const cusp = normalizeSondehubBalloon({ serial: 'X2', lat: 1, lon: 1, vel_v: -0.4 });
  assert.equal(cusp.phase, 'ascending');
});

test('rejects records without a serial or position; falls back type to subtype', () => {
  assert.equal(normalizeSondehubBalloon({ lat: 1, lon: 1, serial: '' }), null);
  assert.equal(normalizeSondehubBalloon({ serial: 'X1', lat: null, lon: 1 }), null);
  const withoutType = normalizeSondehubBalloon({ serial: 'X1', lat: 1, lon: 1, subtype: 'RS41-SGP' });
  assert.equal(withoutType.type, 'RS41-SGP');
});

test('normalizes the dict-of-serials /sondes response shape into a flat array', () => {
  const out = normalizeSondehubResponse({
    X1: { serial: 'X1', lat: 1, lon: 2, vel_v: 3 },
    X2: { serial: 'X2', lat: null, lon: 2 }, // dropped: no position
  });
  assert.equal(out.balloons.length, 1);
  assert.equal(out.balloons[0].serial, 'X1');
  assert.ok(Number.isFinite(out.time));
});

test('a malformed or empty payload yields an empty array, never a throw', () => {
  assert.deepEqual(normalizeSondehubResponse(null).balloons, []);
  assert.deepEqual(normalizeSondehubResponse(undefined).balloons, []);
  assert.deepEqual(normalizeSondehubResponse({}).balloons, []);
});
