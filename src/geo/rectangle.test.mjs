import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { rayEllipsoid, fromDegrees } from './ellipsoid.js';
import {
  rectangleCenter,
  rectangleHeight,
  rectangleWidth,
} from './rectangle.js';

const near = (a, b, eps = 1e-12) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('rectangle extents and middle match the default renderer, across the antimeridian too', () => {
  for (const [w, s, e, n] of [
    [20, 40, 22, 42],
    [170, -10, -170, 10],
    [175, 40, -165, 42],
    [-180, -90, 180, 90],
  ]) {
    const rect = Cesium.Rectangle.fromDegrees(w, s, e, n);
    near(rectangleWidth(rect), Cesium.Rectangle.computeWidth(rect));
    near(rectangleHeight(rect), Cesium.Rectangle.computeHeight(rect));
    const mine = rectangleCenter(rect);
    const theirs = Cesium.Rectangle.center(rect);
    near(mine.lon, theirs.longitude);
    near(mine.lat, theirs.latitude);
  }
});

test('a ray meets the ellipsoid where the default renderer says', () => {
  const origin = fromDegrees(-97, 30, 2e7);
  for (const target of [fromDegrees(-97, 30), fromDegrees(-90, 35)]) {
    const d = Cesium.Cartesian3.normalize(
      Cesium.Cartesian3.subtract(
        new Cesium.Cartesian3(target.x, target.y, target.z),
        new Cesium.Cartesian3(origin.x, origin.y, origin.z),
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    );
    const ray = new Cesium.Ray(
      new Cesium.Cartesian3(origin.x, origin.y, origin.z),
      d,
    );
    const hit = Cesium.IntersectionTests.rayEllipsoid(
      ray,
      Cesium.Ellipsoid.WGS84,
    );
    const theirs = Cesium.Ray.getPoint(ray, hit.start);
    const mine = rayEllipsoid({ origin, direction: d });
    near(mine.x, theirs.x, 1e-6);
    near(mine.y, theirs.y, 1e-6);
    near(mine.z, theirs.z, 1e-6);
  }
  // Looking away, and from inside.
  assert.equal(
    rayEllipsoid({
      origin: fromDegrees(0, 0, 1e7),
      direction: { x: 1, y: 0, z: 0 },
    }),
    null,
    'pointing straight away misses',
  );
  const inside = rayEllipsoid({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
  });
  near(inside.x, 6378137, 1e-6);
});
