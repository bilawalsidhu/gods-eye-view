import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceMeters,
  bearingDegrees,
  compassPoint,
  findLastStop,
  inferOrigin,
} from './ais-origin.js';

const T = 1_700_000_000;
const p = (lat, lon, tOffsetSec, sog) => ({ lat, lon, t: T + tOffsetSec, sog });

test('distance and bearing agree with known geometry', () => {
  // One degree of latitude is ~111 km.
  assert.ok(Math.abs(distanceMeters(0, 0, 1, 0) - 111195) < 500);
  assert.equal(Math.round(bearingDegrees(0, 0, 1, 0)), 0, 'due north');
  assert.equal(Math.round(bearingDegrees(0, 0, 0, 1)), 90, 'due east');
  assert.equal(compassPoint(0), 'north');
  assert.equal(compassPoint(180), 'south');
  assert.equal(compassPoint(225), 'south-west');
});

test('a sustained stop followed by departure is found', () => {
  const track = [
    p(-32.9, 151.8, 0, 0.1),
    p(-32.9, 151.8, 3600, 0.2),   // an hour alongside
    p(-32.8, 151.9, 7200, 8),
    p(-31.0, 152.5, 14400, 10),   // well clear
  ];
  const stop = findLastStop(track);
  assert.ok(stop, 'a one-hour stop then 200 km of passage is a departure');
  assert.equal(stop.durationSec, 3600);
  assert.ok(Math.abs(stop.lat + 32.9) < 1e-9);
});

test('a brief pause is not a port call', () => {
  const track = [
    p(-32.9, 151.8, 0, 0.1),
    p(-32.9, 151.8, 300, 0.1), // five minutes — a lock or a pilot
    p(-31.0, 152.5, 7200, 10),
  ];
  assert.equal(findLastStop(track), null);
});

test('a stop with no departure yet is where it is, not where it came from', () => {
  const track = [
    p(-32.9, 151.8, 0, 0.1),
    p(-32.9, 151.8, 7200, 0.1),
    p(-32.9, 151.81, 8000, 0.3), // still alongside
  ];
  assert.equal(findLastStop(track), null);
});

test('a null speed is unknown, never treated as stopped', () => {
  const track = [
    p(-32.9, 151.8, 0, null),
    p(-32.9, 151.8, 7200, null),
    p(-31.0, 152.5, 14400, 10),
  ];
  assert.equal(findLastStop(track), null, 'missing speed must not invent a call');
});

test('an observed departure is reported with place and duration', () => {
  const track = [
    p(-32.9, 151.8, 0, 0.1),
    p(-32.9, 151.8, 7200, 0.2),
    p(-30.0, 153.0, 20000, 10),
  ];
  const origin = inferOrigin(track, [], { lat: -28.2, lon: 153.8 });
  assert.equal(origin.confidence, 'DEPARTED');
  assert.match(origin.statement, /Departed 32\.90°S 151\.80°E/);
  assert.match(origin.statement, /2h stopped/);
});

test('a changed destination names the previous call', () => {
  const track = [p(-30, 153, 0, 10), p(-28, 153.8, 7200, 10)];
  const voyages = [
    { destination: 'JP KNU', observed: T + 7000 },
    { destination: 'AU BNE', observed: T + 100 },
  ];
  const origin = inferOrigin(track, voyages, { lat: -28, lon: 153.8 });
  assert.equal(origin.confidence, 'PREVIOUS');
  assert.match(origin.statement, /AU BNE/);
});

test('an unchanged destination proves nothing about origin', () => {
  const track = [p(-32.7, 152.5, 0, 10.5), p(-28.2, 153.8, 100000, 9.9)];
  const voyages = [
    { destination: 'JP KNU', observed: T + 90000 },
    { destination: 'JP KNU', observed: T + 100 },
  ];
  const origin = inferOrigin(track, voyages, { lat: -28.2, lon: 153.8 });
  assert.equal(origin.confidence, 'UNOBSERVED');
  assert.match(origin.statement, /Origin not observed/);
  assert.match(origin.statement, /south/, 'it came from the south');
});

test('no track yields no claim at all', () => {
  assert.equal(inferOrigin([], [], null).confidence, 'NONE');
  assert.equal(inferOrigin(null, null, null).confidence, 'NONE');
});
