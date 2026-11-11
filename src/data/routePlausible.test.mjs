// src/data/routePlausible.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greatCircleKm } from '../geoDistance.js';
import { routePlausible } from './routePlausible.js';

const SFO = { lat: 37.6188, lon: -122.3754 };
const LAX = { lat: 33.9416, lon: -118.4085 };
const JFK = { lat: 40.6413, lon: -73.7781 };

test('greatCircleKm sanity: SFO→LAX ≈ 543 km', () => {
  const d = greatCircleKm(SFO, LAX);
  assert.ok(Math.abs(d - 543) < 15, `got ${d}`);
});

test('plane mid-route SFO→LAX: plausible', () => {
  assert.equal(routePlausible({
    latDeg: 35.8, lonDeg: -120.4, altitudeM: 10000, verticalRateMps: 0,
    origin: SFO, destination: LAX,
  }), true);
});

test('plane in London with an SFO→LAX route: implausible', () => {
  assert.equal(routePlausible({
    latDeg: 51.5, lonDeg: -0.12, altitudeM: 10000, verticalRateMps: 0,
    origin: SFO, destination: LAX,
  }), false);
});

test('a long route allows a wider corridor; a short one does not', () => {
  // JFK→SFO over Kansas, 384 km south of the great circle.
  assert.equal(routePlausible({
    latDeg: 38.21, lonDeg: -99.69, altitudeM: 10370, verticalRateMps: 0,
    origin: JFK, destination: SFO,
  }), true);
  // 516 km off the 543 km SFO→LAX route is still the wrong route.
  assert.equal(routePlausible({
    latDeg: 37.9, lonDeg: -115.0, altitudeM: 10000, verticalRateMps: 0,
    origin: SFO, destination: LAX,
  }), false);
  // 960 km off, past 15 % of the 4,152 km JFK→SFO route, is still wrong.
  assert.equal(routePlausible({
    latDeg: 33.0, lonDeg: -99.69, altitudeM: 10000, verticalRateMps: 0,
    origin: JFK, destination: SFO,
  }), false);
});

test('vertical trend: low climbing plane near SFO — origin must be local', () => {
  const nearSfo = { latDeg: 37.7, lonDeg: -122.4, altitudeM: 2500 };
  // JFK→SFO passes geometry (near destination), but a CLIMBING plane here just
  // departed — origin JFK (far) contradicts it.
  assert.equal(routePlausible({ ...nearSfo, verticalRateMps: 8, origin: JFK, destination: SFO }), false);
  // The same plane DESCENDING is arriving at SFO — plausible.
  assert.equal(routePlausible({ ...nearSfo, verticalRateMps: -8, origin: JFK, destination: SFO }), true);
});

test('missing data never hides a route (cannot judge → allow)', () => {
  assert.equal(routePlausible({ latDeg: 35.8, lonDeg: -120.4, origin: null, destination: null }), true);
  assert.equal(routePlausible({
    latDeg: 51.5, lonDeg: -0.12,
    origin: { lat: null, lon: null }, destination: null,
  }), true);
  assert.equal(routePlausible({
    latDeg: 95, lonDeg: 0,
    origin: SFO, destination: LAX,
  }), true);
});
