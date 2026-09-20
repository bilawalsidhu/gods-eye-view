import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extrapolateGreatCircle,
  predictVehicleTrajectory,
  predictSatelliteOrbit,
} from './trajectoryPredictor.js';

test('extrapolateGreatCircle advances latitude and longitude correctly', () => {
  // Heading North (0 deg) from equator (0, 0) by ~111 km (1 degree)
  const resultNorth = extrapolateGreatCircle(0, 0, 0, 111195);
  assert.ok(Math.abs(resultNorth.latDeg - 1.0) < 0.05);
  assert.ok(Math.abs(resultNorth.lonDeg - 0.0) < 0.05);

  // Heading East (90 deg) from equator (0, 0) by ~111 km
  const resultEast = extrapolateGreatCircle(0, 0, 90, 111195);
  assert.ok(Math.abs(resultEast.latDeg - 0.0) < 0.05);
  assert.ok(Math.abs(resultEast.lonDeg - 1.0) < 0.05);
});

test('predictVehicleTrajectory yields horizon-partitioned waypoints with climbing profile', () => {
  const segments = predictVehicleTrajectory({
    latDeg: 40.7128,
    lonDeg: -74.0060,
    altitudeM: 10000,
    headingDeg: 90,
    speedKts: 450,
    verticalRateFpm: 1000,
  });

  assert.equal(segments.length, 3);
  assert.equal(segments[0].horizonSec, 300);
  assert.equal(segments[1].horizonSec, 900);
  assert.equal(segments[2].horizonSec, 1800);

  // Check that altitude increases with positive vertical rate
  const firstWp = segments[0].waypoints[0];
  const lastWp = segments[2].waypoints[segments[2].waypoints.length - 1];
  assert.ok(lastWp.altitudeM > firstWp.altitudeM);
  assert.ok(lastWp.lonDeg > firstWp.lonDeg); // Heading east
});

test('predictSatelliteOrbit propagates TLE lines into valid groundtrack points', () => {
  // ISS (ZARYA) sample TLE
  const tle1 = '1 25544U 98067A   24080.52857639  .00016717  00000+0  30123-3 0  9998';
  const tle2 = '2 25544  51.6416 182.1643 0005215  44.8211  82.5298 15.49885854444585';

  const orbit = predictSatelliteOrbit(tle1, tle2, new Date('2024-03-20T12:00:00Z'), 1800, 300);

  assert.ok(orbit.groundtrack.length > 5);
  assert.ok(orbit.footprintRadiusM > 1000000); // ISS footprint is ~2200km radius
  assert.ok(orbit.currentPosition !== null);
  assert.ok(orbit.currentPosition.altitudeM > 350000); // ISS altitude ~420km
});
