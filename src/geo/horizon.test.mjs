import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { fromDegrees } from './ellipsoid.js';
import { horizonFrom } from './horizon.js';

test('the horizon hides what the default renderer’s occluder hides', () => {
  let seed = 3;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 30; i++) {
    const eye = fromDegrees(
      random() * 360 - 180,
      random() * 170 - 85,
      i === 0 ? -100 : random() * 2e7,
    );
    const occluder = new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      new Cesium.Cartesian3(eye.x, eye.y, eye.z),
    );
    const horizon = horizonFrom(eye);
    for (let k = 0; k < 50; k++) {
      const p = fromDegrees(
        random() * 360 - 180,
        random() * 180 - 90,
        random() * 1e5,
      );
      assert.equal(
        horizon.isPointVisible(p),
        occluder.isPointVisible(new Cesium.Cartesian3(p.x, p.y, p.z)),
      );
    }
  }
});
