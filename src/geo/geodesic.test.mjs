import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { surfaceDistance } from './geodesic.js';

test('surface distance matches the default renderer’s geodesic', () => {
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const d = Math.PI / 180;
  const geodesic = new Cesium.EllipsoidGeodesic();
  for (let i = 0; i < 400; i++) {
    const start = {
      lon: (random() * 360 - 180) * d,
      lat: (random() * 170 - 85) * d,
    };
    // Near pairs, as a nearby-sites query asks, and far ones short of antipodal.
    const reach = i % 2 ? 2 : 120;
    const end = {
      lon: start.lon + (random() * 2 - 1) * reach * d,
      lat:
        Math.max(
          -89,
          Math.min(89, start.lat / d + (random() * 2 - 1) * reach),
        ) * d,
    };
    geodesic.setEndPoints(
      new Cesium.Cartographic(start.lon, start.lat, 0),
      new Cesium.Cartographic(end.lon, end.lat, 0),
    );
    const expected = geodesic.surfaceDistance;
    assert.ok(
      Math.abs(surfaceDistance(start, end) - expected) <=
        1e-9 * Math.max(1, expected),
      `${i}: ${surfaceDistance(start, end)} vs ${expected}`,
    );
  }
});

test('the same point is no distance away, and nearly antipodal points still answer', () => {
  const p = { lon: 0.3, lat: 0.7 };
  assert.equal(surfaceDistance(p, p), 0);
  const far = surfaceDistance(
    { lon: 0, lat: 0 },
    { lon: Math.PI - 1e-9, lat: 0 },
  );
  assert.ok(Number.isFinite(far) && far > 1.9e7);
});
