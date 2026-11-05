import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from './index.js';
const tuple = (p) => [p.longitude, p.latitude, p.height];
test('Vincenty distance, headings and interpolation are exactly the Cesium oracle', () => {
  let checked = 0;
  for (let i = 0; i < 120; i++) {
    const a = geo.cartographic.fromDegrees(
      ((i * 43.17) % 340) - 170,
      ((i * 17.23) % 150) - 75,
      123,
    );
    const b = geo.cartographic.fromDegrees(
      ((i * 83.31 + 20) % 340) - 170,
      ((i * 7.43 + 9) % 150) - 75,
      567,
    );
    let c;
    try {
      c = new Cesium.EllipsoidGeodesic(a, b);
    } catch {
      assert.throws(() => geo.ellipsoidGeodesic.create(a, b));
      continue;
    }
    const g = geo.ellipsoidGeodesic.create(a, b);
    checked++;
    for (const key of ['surfaceDistance', 'startHeading', 'endHeading'])
      assert.equal(g[key], c[key]);
    assert.equal(g.start.height, 0);
    assert.equal(g.end.height, 0);
    for (const f of [-0.2, 0, 0.25, 0.5, 0.75, 1, 1.2])
      assert.deepEqual(
        tuple(g.interpolateUsingFraction(f)),
        tuple(c.interpolateUsingFraction(f)),
      );
  }
  assert.ok(checked > 100);
});
test('endpoint reset, result reuse, custom sphere and dateline/polar paths retain native results', () => {
  const g = geo.ellipsoidGeodesic.create(
    undefined,
    undefined,
    geo.ellipsoid.create(1e7, 1e7, 1e7),
  );
  const c = new Cesium.EllipsoidGeodesic(
    undefined,
    undefined,
    new Cesium.Ellipsoid(1e7, 1e7, 1e7),
  );
  for (const [lon1, lat1, lon2, lat2] of [
    [179.8, 70, -179.8, 69.9],
    [0, 89.99, 120, 50],
    [12, -50, -80, 70],
  ]) {
    const a = geo.cartographic.fromDegrees(lon1, lat1),
      b = geo.cartographic.fromDegrees(lon2, lat2);
    g.setEndPoints(a, b);
    c.setEndPoints(a, b);
    assert.equal(g.surfaceDistance, c.surfaceDistance);
    const result = geo.cartographic.create();
    assert.equal(g.interpolateUsingSurfaceDistance(12345, result), result);
    assert.deepEqual(
      tuple(result),
      tuple(c.interpolateUsingSurfaceDistance(12345)),
    );
  }
});
