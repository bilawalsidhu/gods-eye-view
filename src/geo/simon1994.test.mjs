// Bit-for-bit comparison of the Sun and Moon positions, the TAI dates they
// take and the TEME rotation with Cesium's, over dates from 1960 to 2100
// (leap second edges included).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from './index.js';

const same = (a, b, label) =>
  assert.ok(Object.is(a, b), `${label}: ${a} !== ${b}`);
const dates = [
  Date.UTC(1960, 0, 1),
  Date.UTC(1972, 0, 1),
  Date.UTC(1972, 0, 1) - 1,
  Date.UTC(2016, 11, 31, 23, 59, 59, 999),
  Date.UTC(2017, 0, 1),
  Date.UTC(2026, 10, 4, 12, 30, 15, 250),
  Date.UTC(2100, 5, 30, 11, 59, 59, 500),
];
for (let i = 0; i < 400; i++)
  dates.push(Date.UTC(1990, 0, 1) + Math.floor(i * 7919.123 * 3600 * 1000));

test('dates from JavaScript Dates match Cesium JulianDate.fromDate', () => {
  for (const ms of dates) {
    const ours = geo.julianDate.fromDate(new Date(ms));
    const theirs = Cesium.JulianDate.fromDate(new Date(ms));
    same(ours.dayNumber, theirs.dayNumber, `${ms} day`);
    same(ours.secondsOfDay, theirs.secondsOfDay, `${ms} seconds`);
    same(
      geo.julianDate.computeTaiMinusUtc(ours),
      Cesium.JulianDate.computeTaiMinusUtc(theirs),
      `${ms} TAI - UTC`,
    );
  }
});

test('Sun and Moon inertial positions and the TEME rotation match Cesium bit for bit', () => {
  const Simon = Cesium.Simon1994PlanetaryPositions;
  for (const ms of dates) {
    const ours = geo.julianDate.fromDate(new Date(ms));
    const theirs = Cesium.JulianDate.fromDate(new Date(ms));
    for (const [name, mine, cesium] of [
      [
        'sun',
        geo.simon1994.computeSunPositionInEarthInertialFrame(ours),
        Simon.computeSunPositionInEarthInertialFrame(theirs),
      ],
      [
        'moon',
        geo.simon1994.computeMoonPositionInEarthInertialFrame(ours),
        Simon.computeMoonPositionInEarthInertialFrame(theirs),
      ],
    ])
      for (const axis of ['x', 'y', 'z'])
        same(mine[axis], cesium[axis], `${ms} ${name}.${axis}`);
    const teme = geo.transforms.computeTemeToPseudoFixedMatrix(ours);
    const cesiumTeme = Cesium.Transforms.computeTemeToPseudoFixedMatrix(theirs);
    for (let k = 0; k < 9; k++)
      same(teme[k], cesiumTeme[k], `${ms} teme[${k}]`);
  }
});
