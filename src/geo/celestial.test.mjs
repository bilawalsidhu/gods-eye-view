import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  moonPositionFixed,
  moonPositionInertial,
  sunPositionFixed,
  sunPositionInertial,
  temeToPseudoFixed,
} from './celestial.js';

/*
 * The port runs Cesium's operations in the same order with the same Math
 * functions, so every component must be identical (Object.is, so signed
 * zeros count). Any operation-order slip shows up as a difference.
 */

/** A seeded generator, so a failure names a reproducible point. */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const START = Date.UTC(1990, 0, 1);
const END = Date.UTC(2050, 0, 1);
const year = (y) => new Date(0).setUTCFullYear(y, 0, 1);

/** Seeded times in 1990-2050 and -500 to 3000, the epoch, and steps across every leap second. */
function sampleTimes() {
  const next = random(0x5eed);
  const times = [];
  for (let i = 0; i < 4000; i++) {
    times.push(Math.round(START + next() * (END - START)));
  }
  // Far from J2000, where Kepler's revolutions count, and before 1972, where
  // UTC to TAI takes the table's first offset.
  for (let i = 0; i < 400; i++)
    times.push(Math.round(year(-500) + next() * (year(3000) - year(-500))));
  times.push(
    year(1900),
    year(1960),
    -1,
    0,
    Date.UTC(1971, 11, 31, 23, 59, 59, 999),
    Date.UTC(1972, 0, 1),
    Date.UTC(1972, 6, 1) - 1,
    year(2100),
    year(3000),
  );
  // Each leap second Cesium knows, 1.5 s either side.
  const boundaries = [
    [1972, 6],
    [1973, 0],
    [1974, 0],
    [1975, 0],
    [1976, 0],
    [1977, 0],
    [1978, 0],
    [1979, 0],
    [1980, 0],
    [1981, 6],
    [1982, 6],
    [1983, 6],
    [1985, 6],
    [1988, 0],
    [1990, 0],
    [1991, 0],
    [1992, 6],
    [1993, 6],
    [1994, 6],
    [1996, 0],
    [1997, 6],
    [1999, 0],
    [2006, 0],
    [2009, 0],
    [2012, 6],
    [2015, 6],
    [2017, 0],
  ];
  for (const [year, month] of boundaries) {
    const at = Date.UTC(year, month, 1);
    for (let d = -1500; d <= 1500; d += 125) times.push(at + d);
  }
  // The span the task names, millisecond by millisecond at the edges.
  const leap = Date.UTC(2017, 0, 1);
  for (let d = -1000; d <= 1000; d += 1) {
    if (Math.abs(d) <= 5 || Math.abs(d) >= 995 || d % 50 === 0) {
      times.push(leap + d);
    }
  }
  // Noon/midnight edges (secondsOfDay wrap), J2000, and before the epoch.
  times.push(
    Date.UTC(2000, 0, 1, 12),
    Date.UTC(2000, 0, 1, 11, 58, 55, 816),
    Date.UTC(2000, 0, 1, 11, 59, 59, 999),
    Date.UTC(2024, 5, 30, 12, 0, 0, 0),
    Date.UTC(2024, 5, 30, 11, 59, 59, 999),
    Date.UTC(2024, 5, 30, 23, 59, 59, 999),
    START,
    END,
  );
  return times;
}

const TIMES = sampleTimes();
const julian = (ms) => Cesium.JulianDate.fromDate(new Date(ms));
const iso = (ms) => new Date(ms).toISOString();

function sameOver(label, compute, expected) {
  for (const ms of TIMES) {
    const ours = compute(ms);
    const theirs = expected(ms);
    for (const k of ['x', 'y', 'z'])
      assert.ok(
        Object.is(ours[k], theirs[k]),
        `${label} ${k} at ${iso(ms)} (${ms}): ${ours[k]} vs ${theirs[k]}`,
      );
  }
}

function cesiumFixed(ms, compute) {
  const time = julian(ms);
  const inertial = compute(time, new Cesium.Cartesian3());
  const matrix = Cesium.Transforms.computeTemeToPseudoFixedMatrix(time);
  return Cesium.Matrix3.multiplyByVector(
    matrix,
    inertial,
    new Cesium.Cartesian3(),
  );
}

const { Simon1994PlanetaryPositions: Simon } = Cesium;

test('sunPositionInertial matches Simon1994PlanetaryPositions', () => {
  sameOver('sun inertial', sunPositionInertial, (ms) =>
    Simon.computeSunPositionInEarthInertialFrame(julian(ms)),
  );
});

test('moonPositionInertial matches Simon1994PlanetaryPositions', () => {
  sameOver('moon inertial', moonPositionInertial, (ms) =>
    Simon.computeMoonPositionInEarthInertialFrame(julian(ms)),
  );
});

test('temeToPseudoFixed matches Transforms.computeTemeToPseudoFixedMatrix', () => {
  for (const ms of TIMES) {
    const ours = temeToPseudoFixed(ms);
    const theirs = Cesium.Transforms.computeTemeToPseudoFixedMatrix(julian(ms));
    ['x', 'y', 'z'].forEach((axis, c) =>
      ['x', 'y', 'z'].forEach((k, r) =>
        assert.ok(
          Object.is(ours[axis][k], theirs[c * 3 + r]),
          `${axis}.${k} at ${iso(ms)} (${ms}): ${ours[axis][k]} vs ${theirs[c * 3 + r]}`,
        ),
      ),
    );
  }
});

test('sunPositionFixed matches the pseudo-fixed rotation of the sun', () => {
  sameOver('sun fixed', sunPositionFixed, (ms) =>
    cesiumFixed(ms, Simon.computeSunPositionInEarthInertialFrame),
  );
});

test('moonPositionFixed matches the pseudo-fixed rotation of the moon', () => {
  sameOver('moon fixed', moonPositionFixed, (ms) =>
    cesiumFixed(ms, Simon.computeMoonPositionInEarthInertialFrame),
  );
});

test('positions are plausible: 1 AU sun, ~384,000 km moon', () => {
  const ms = Date.UTC(2026, 10, 5);
  const sun = sunPositionInertial(ms);
  const moon = moonPositionInertial(ms);
  const au = Math.hypot(sun.x, sun.y, sun.z) / 1.4959787e11;
  const moonKm = Math.hypot(moon.x, moon.y, moon.z) / 1000;
  assert.ok(au > 0.98 && au < 1.02, `sun at ${au} AU`);
  assert.ok(moonKm > 356000 && moonKm < 407000, `moon at ${moonKm} km`);
});

test('times outside the model throw', () => {
  for (const fn of [
    sunPositionInertial,
    moonPositionInertial,
    temeToPseudoFixed,
    sunPositionFixed,
    moonPositionFixed,
  ])
    for (const ms of [NaN, Infinity, -Infinity, 8.64e15 + 1])
      assert.throws(() => fn(ms), RangeError, `${fn.name}(${ms})`);
  const farFuture = Date.parse('+050000-01-01T00:00:00Z');
  assert.throws(() => sunPositionInertial(farFuture), /eccentricity/);
  for (const fn of [sunPositionInertial, moonPositionInertial])
    assert.throws(() => fn(-8.64e15), /inclination/);
});
