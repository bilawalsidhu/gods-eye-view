import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { fromDegrees, offsetEllipsoid } from './ellipsoid.js';
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

test('a horizon on a lowered ellipsoid hides what the occluder on it hides', () => {
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const radii = Cesium.Ellipsoid.WGS84.radii;
  const lowered = new Cesium.Ellipsoid(
    radii.x - 1000,
    radii.y - 1000,
    radii.z - 1000,
  );
  for (let i = 0; i < 30; i++) {
    const eye = fromDegrees(
      random() * 360 - 180,
      random() * 170 - 85,
      i === 0 ? -1500 : random() * 2e5 - 500,
    );
    const occluder = new Cesium.EllipsoidalOccluder(
      lowered,
      new Cesium.Cartesian3(eye.x, eye.y, eye.z),
    );
    const horizon = horizonFrom(eye, offsetEllipsoid(-1000));
    for (let k = 0; k < 50; k++) {
      const p = fromDegrees(random() * 360 - 180, random() * 180 - 90, 0);
      assert.equal(
        horizon.isPointVisible(p),
        occluder.isPointVisible(new Cesium.Cartesian3(p.x, p.y, p.z)),
      );
    }
  }
});
