// src/layers/satellites/motion.test.mjs — a satellite's point reckoned from
// one SGP4 sample stays on SGP4's track between samples.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { gstime, twoline2satrec } from 'satellite.js';
import { createOrbits } from './orbits.js';
import { reckonEarthFixed, sampleOrbit } from './motion.js';

const ISS = twoline2satrec(
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
);
const AT_MS = Date.UTC(2008, 8, 20, 12, 30, 0);
const orbits = createOrbits({ state: {}, services: {}, parts: {} });

/** Where the layer has always drawn a satellite: SGP4, through geodetic. */
function drawnBySgp4(atMs) {
  const pos = orbits.propagatePosition(ISS, new Date(atMs));
  return Cesium.Cartesian3.fromDegrees(
    pos.longitude,
    pos.latitude,
    pos.altitude,
  );
}

function reckoned(sample, atMs) {
  return reckonEarthFixed(
    sample,
    atMs,
    gstime(new Date(atMs)),
    new Cesium.Cartesian3(),
  );
}

test('at its own time the reckoned point is where SGP4 draws it', () => {
  const sample = sampleOrbit(ISS, AT_MS);
  const gap = Cesium.Cartesian3.distance(
    reckoned(sample, AT_MS),
    drawnBySgp4(AT_MS),
  );
  assert.ok(gap < 1, `${gap} m`);
});

test('between samples the point keeps to the SGP4 track', () => {
  const sample = sampleOrbit(ISS, AT_MS);
  for (const [seconds, withinM] of [
    [0.016, 1],
    [1, 2],
    [10, 2],
    [30, 10],
    [60, 50],
  ]) {
    const atMs = AT_MS + seconds * 1000;
    const gap = Cesium.Cartesian3.distance(
      reckoned(sample, atMs),
      drawnBySgp4(atMs),
    );
    assert.ok(gap < withinM, `${seconds} s: ${gap} m`);
  }
});

test('the point moves every frame, at orbital speed', () => {
  const sample = sampleOrbit(ISS, AT_MS);
  const a = reckoned(sample, AT_MS + 500);
  const b = reckoned(sample, AT_MS + 516);
  const speed = Cesium.Cartesian3.distance(a, b) / 0.016;
  // ISS ground-relative speed: about 7.2–7.7 km/s.
  assert.ok(speed > 7000 && speed < 8000, `${speed} m/s`);
});

test('reckoning backwards in time works as forwards', () => {
  const sample = sampleOrbit(ISS, AT_MS);
  const atMs = AT_MS - 30_000;
  const gap = Cesium.Cartesian3.distance(
    reckoned(sample, atMs),
    drawnBySgp4(atMs),
  );
  assert.ok(gap < 10, `${gap} m`);
});

test('an element set SGP4 cannot propagate has no sample', () => {
  const decayed = { ...ISS, error: 0 };
  decayed.ecco = 2; // not an orbit
  assert.equal(sampleOrbit(decayed, AT_MS), null);
});
