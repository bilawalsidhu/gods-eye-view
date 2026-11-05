// src/geo/index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as geo from './index.js';

test('the public entry exposes every namespace', () => {
  for (const name of [
    'math',
    'ellipsoid',
    'cartographic',
    'cartesian2',
    'cartesian3',
    'matrix3',
    'matrix4',
    'quaternion',
    'transforms',
  ]) {
    assert.equal(typeof geo[name], 'object', name);
  }
  assert.equal(typeof geo.cartesian3.fromDegrees, 'function');
  assert.equal(geo.ellipsoid.WGS84.maximumRadius, 6378137);
});
