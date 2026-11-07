import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { fromDegrees } from './ellipsoid.js';
import { sphereFromPoints } from './sphere.js';

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
