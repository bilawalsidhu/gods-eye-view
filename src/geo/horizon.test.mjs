import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { fromDegrees, offsetEllipsoid } from './ellipsoid.js';
import {
  horizonFrom,
  liftedForHorizon,
  liftedForHorizonInto,
} from './horizon.js';

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

test('liftedForHorizonInto writes liftedForHorizon’s point into the given vector', () => {
  const out = { x: NaN, y: NaN, z: NaN };
  const points = [
    fromDegrees(-97.04, 32.9, 10_500), // well above the lift
    fromDegrees(4.1, 51.95, 2), // below the 12 m lift
    fromDegrees(151.2, -33.9, -30), // below the ellipsoid (sea at the geoid)
    fromDegrees(0, 0, 0),
    fromDegrees(0, 90, 5), // the poles, under and over the lift
    fromDegrees(0, -90, 400),
    { x: 0, y: 0, z: 6_356_752.314245 },
    { x: 0, y: 0, z: -6_356_760 },
  ];
  for (const p of points) {
    for (const minHeightM of [undefined, 0, 12, 250]) {
      const expected =
        minHeightM === undefined
          ? liftedForHorizon(p)
          : liftedForHorizon(p, minHeightM);
      const written = liftedForHorizonInto(p, out, minHeightM);
      assert.equal(written, out, 'written into the given vector');
      for (const axis of ['x', 'y', 'z'])
        assert.ok(
          Math.abs(out[axis] - expected[axis]) <= 1e-9,
          `${axis} at ${JSON.stringify(p)} lift ${minHeightM}: ${out[axis]} vs ${expected[axis]}`,
        );
    }
  }
  // The input is only read.
  const p = fromDegrees(4.1, 51.95, 2);
  const copy = { ...p };
  liftedForHorizonInto(p, out);
  assert.deepEqual({ ...p }, copy);
});
