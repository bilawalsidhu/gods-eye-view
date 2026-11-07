import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { fromDegrees } from './ellipsoid.js';
import { sphereFromPoints, sphereUnion } from './sphere.js';

test('a sphere from points is the default renderer’s, to the bit', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const cases = [
    [],
    [fromDegrees(10, 20)],
    [fromDegrees(-125.8, 15.5), fromDegrees(-130, 18), fromDegrees(-135, 21)],
    // Across the antimeridian, and a long track.
    Array.from({ length: 40 }, (_, i) => fromDegrees(170 + i, -10 + i / 2)),
    Array.from({ length: 200 }, () =>
      fromDegrees(random() * 360 - 180, random() * 180 - 90, random() * 1e5),
    ),
  ];
  for (const points of cases) {
    const ours = sphereFromPoints(points);
    const theirs = Cesium.BoundingSphere.fromPoints(
      points.map((p) => new Cesium.Cartesian3(p.x, p.y, p.z)),
    );
    assert.deepEqual(
      [ours.center.x, ours.center.y, ours.center.z, ours.radius],
      [theirs.center.x, theirs.center.y, theirs.center.z, theirs.radius],
    );
  }
});

test('the union of two spheres is the default renderer’s, to the bit', () => {
  const sphere = (x, y, z, radius) => ({ center: { x, y, z }, radius });
  const cases = [
    // Apart, overlapping, one inside the other either way, concentric.
    [sphere(0, 0, 0, 6378137), sphere(4.2e7, 1e6, -3e5, 2.1e7)],
    [sphere(1, 2, 3, 10), sphere(5, -4, 2, 8)],
    [sphere(0, 0, 0, 6378137), sphere(1e5, 0, 0, 7000)],
    [sphere(1e5, 0, 0, 7000), sphere(0, 0, 0, 6378137)],
    [sphere(3, 3, 3, 5), sphere(3, 3, 3, 5)],
  ];
  for (const [left, right] of cases) {
    const ours = sphereUnion(left, right);
    const theirs = Cesium.BoundingSphere.union(
      new Cesium.BoundingSphere(
        new Cesium.Cartesian3(left.center.x, left.center.y, left.center.z),
        left.radius,
      ),
      new Cesium.BoundingSphere(
        new Cesium.Cartesian3(right.center.x, right.center.y, right.center.z),
        right.radius,
      ),
    );
    assert.deepEqual(
      [ours.center.x, ours.center.y, ours.center.z, ours.radius],
      [theirs.center.x, theirs.center.y, theirs.center.z, theirs.radius],
    );
  }
});
