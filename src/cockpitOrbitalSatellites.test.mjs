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

test('a hop to the opposite side goes round the Earth, not through it', () => {
  const from = at(0, 0, 400_000);
  const to = at(0, 180, 400_000);
  const radius = Cesium.Cartesian3.magnitude(from);
  for (const p of [0.25, 0.5, 0.75]) {
    const point = hopPosition(from, to, p);
    assert.ok(
      Math.abs(Math.hypot(point.x, point.y, point.z) - radius) < 1e-3,
      `p=${p}`,
    );
  }
  const end = hopPosition(from, to, 1);
  for (const axis of ['x', 'y', 'z'])
    assert.ok(Math.abs(end[axis] - to[axis]) < 1e-3, axis);
});

test('a hop to nearly the opposite side moves smoothly as the destination does', () => {
  const r = 6_778_137;
  const from = { x: r, y: 0, z: 0 };
  const near = (delta) => ({
    x: -r * Math.cos(delta),
    y: r * Math.sin(delta),
    z: 0,
  });
  const mid = (delta) => hopPosition(from, near(delta), 0.5);
  const [a, b] = [mid(0.999e-6), mid(1.001e-6)];
  assert.ok(
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1,
    'no jump between neighbours',
  );
  for (const delta of [1e-3, 1e-6, 1e-9]) {
    const to = near(delta);
    const end = hopPosition(from, to, 1);
    assert.ok(
      Math.hypot(end.x - to.x, end.y - to.y, end.z - to.z) < 1e-3,
      `lands at ${delta}`,
    );
    const half = mid(delta);
    assert.ok(
      Math.abs(Math.hypot(half.x, half.y, half.z) - r) < 1e-3,
      `round at ${delta}`,
    );
  }
});
