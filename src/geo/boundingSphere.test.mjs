import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from './index.js';
const tuple = (s) => [s.center.x, s.center.y, s.center.z, s.radius];
test('mission sphere fit and Earth/orbit union match native Cesium exactly', () => {
  for (let i = 0; i < 40; i++) {
    const positions = Array.from({ length: i * 3 }, (_, j) =>
      geo.cartesian3.fromDegrees(
        ((j * 73 + i * 11) % 360) - 180,
        ((j * 29) % 170) - 85,
        5e5 + i * 1e6,
      ),
    );
    const fit = geo.boundingSphere.fromPoints(positions),
      native = Cesium.BoundingSphere.fromPoints(positions);
    assert.deepEqual(tuple(fit), tuple(native));
    const earth = geo.boundingSphere.create(geo.cartesian3.ZERO, 6378137);
    assert.deepEqual(
      tuple(geo.boundingSphere.union(earth, fit)),
      tuple(
        Cesium.BoundingSphere.union(
          new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, 6378137),
          native,
        ),
      ),
    );
  }
});
test('union handles containment, in-place results and empty fits', () => {
  const outer = geo.boundingSphere.create(geo.cartesian3.create(1, 2, 3), 20),
    inner = geo.boundingSphere.create(geo.cartesian3.create(2, 2, 3), 1);
  assert.equal(geo.boundingSphere.union(outer, inner, inner), inner);
  assert.deepEqual(tuple(inner), tuple(outer));
  assert.deepEqual(tuple(geo.boundingSphere.fromPoints([])), [0, 0, 0, 0]);
});
