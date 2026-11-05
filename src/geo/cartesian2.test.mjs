// src/geo/cartesian2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as c2 from './cartesian2.js';

test('cartesian2 create, clone and distance equal Cesium', () => {
  const a = c2.create(3, 4);
  assert.deepEqual({ ...a }, { x: 3, y: 4 });
  const out = c2.create();
  assert.equal(c2.clone(a, out), out);
  assert.equal(
    c2.distance(a, c2.create()),
    Cesium.Cartesian2.distance(
      new Cesium.Cartesian2(3, 4),
      new Cesium.Cartesian2(),
    ),
  );
});
