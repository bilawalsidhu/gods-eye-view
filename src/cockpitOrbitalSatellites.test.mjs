// src/cockpitOrbitalSatellites.test.mjs — the camera's hop from one ridden
// satellite to another.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { hopPosition } from './cockpitOrbitalSatellites.js';

const at = (lat, lon, alt) => Cesium.Cartesian3.fromDegrees(lon, lat, alt);

test('the hop follows the great circle and lands on the satellite', () => {
  const from = at(0, 0, 400_000);
  const to = at(0, 90, 800_000);
  const start = hopPosition(from, to, 0);
  for (const axis of ['x', 'y', 'z'])
    assert.ok(Math.abs(start[axis] - from[axis]) < 1e-6, axis);
  const end = hopPosition(from, to, 1);
  for (const axis of ['x', 'y', 'z'])
    assert.ok(Math.abs(end[axis] - to[axis]) < 1e-6, axis);
  // Half-way it is above the Earth, between the two heights, not on the
  // chord through it.
  const mid = hopPosition(from, to, 0.5);
  const radius = Math.hypot(mid.x, mid.y, mid.z);
  const ra = Cesium.Cartesian3.magnitude(from);
  const rb = Cesium.Cartesian3.magnitude(to);
  assert.ok(Math.abs(radius - (ra + rb) / 2) < 1e-6);
  assert.ok(Math.abs(Math.atan2(mid.y, mid.x) - Math.PI / 4) < 1e-9);
  assert.equal(hopPosition(null, to, 0.5), null);
});
