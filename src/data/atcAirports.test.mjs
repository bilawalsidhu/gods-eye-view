import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GLOBAL_AIRPORTS,
  greatCircleDistanceM,
  metersToNauticalMiles,
  findNearestAirport,
  getAirportByIcao,
} from './atcAirports.js';

test('atcAirports: metersToNauticalMiles converts correctly', () => {
  assert.equal(metersToNauticalMiles(1852), 1);
  assert.equal(metersToNauticalMiles(0), 0);
  assert.equal(metersToNauticalMiles(-100), 0);
  assert.equal(metersToNauticalMiles(null), 0);
});

test('atcAirports: greatCircleDistanceM computes accurate spherical distance', () => {
  // Austin Bergstrom (30.1945, -97.6699) to Dallas Fort Worth (32.8998, -97.0403) is ~305 km
  const dist = greatCircleDistanceM(30.1945, -97.6699, 32.8998, -97.0403);
  assert.ok(dist > 300000 && dist < 315000, `Expected ~305 km, got ${dist}`);

  // Distance from a point to itself is 0
  assert.equal(greatCircleDistanceM(40.64, -73.78, 40.64, -73.78), 0);

  // Invalid coordinates return infinity
  assert.equal(greatCircleDistanceM(NaN, 0, 10, 20), Number.POSITIVE_INFINITY);
  assert.equal(greatCircleDistanceM(10, 20, null, 30), Number.POSITIVE_INFINITY);
});

test('atcAirports: findNearestAirport finds the correct closest airport', () => {
  // Near downtown Austin (30.27, -97.74) -> should find KAUS
  const matchAustin = findNearestAirport(30.27, -97.74);
  assert.ok(matchAustin);
  assert.equal(matchAustin.airport.icao, 'KAUS');
  assert.ok(matchAustin.distanceNm < 15, `Expected < 15 NM, got ${matchAustin.distanceNm}`);

  // Near Santa Monica (34.01, -118.49) -> finds KSMO (Santa Monica Municipal)
  const matchSmo = findNearestAirport(34.01, -118.49);
  assert.ok(matchSmo);
  assert.equal(matchSmo.airport.icao, 'KSMO');

  // Near LAX (33.94, -118.41) -> finds KLAX
  const matchLa = findNearestAirport(33.94, -118.41);
  assert.ok(matchLa);
  assert.equal(matchLa.airport.icao, 'KLAX');

  // Global: Near London Heathrow (51.47, -0.46) -> finds EGLL
  const matchLondon = findNearestAirport(51.47, -0.46);
  assert.ok(matchLondon);
  assert.equal(matchLondon.airport.icao, 'EGLL');

  // Distance threshold check: Max range 5 km when airport is 15 km away -> returns null
  const matchCapped = findNearestAirport(30.27, -97.74, 5000);
  assert.equal(matchCapped, null);
});

test('atcAirports: getAirportByIcao handles case and whitespace', () => {
  const aus = getAirportByIcao('kaus');
  assert.ok(aus);
  assert.equal(aus.icao, 'KAUS');
  assert.equal(aus.iata, 'AUS');

  const jfk = getAirportByIcao('  KJFK  ');
  assert.ok(jfk);
  assert.equal(jfk.icao, 'KJFK');

  assert.equal(getAirportByIcao('UNKNOWN_AIRPORT'), null);
  assert.equal(getAirportByIcao(''), null);
  assert.equal(getAirportByIcao(null), null);
});

test('atcAirports: all global airports have valid structure and frequencies', () => {
  assert.ok(GLOBAL_AIRPORTS.length >= 40, `Expected at least 40 airports, got ${GLOBAL_AIRPORTS.length}`);

  for (const airport of GLOBAL_AIRPORTS) {
    assert.equal(typeof airport.icao, 'string');
    assert.equal(airport.icao.length, 4);
    assert.ok(Number.isFinite(airport.lat) && airport.lat >= -90 && airport.lat <= 90);
    assert.ok(Number.isFinite(airport.lon) && airport.lon >= -180 && airport.lon <= 180);
    assert.ok(airport.frequencies?.tower, `Missing tower freq for ${airport.icao}`);
  }
});
