import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  rectangleWidth,
  rectangleHeight,
  rectangleCenter,
  cloneRectangle,
} from './rectangle.js';

test('plain FIRMS viewport bounds preserve native date-line, pole and global rectangle arithmetic', () => {
  for (const bounds of [
    [-123, 37, -121, 39],
    [179, -20, -179, 20],
    [-180, -90, 180, 90],
    [170, 85, -170, 90],
    [-170, -90, 170, -85],
  ]) {
    const native = Cesium.Rectangle.fromDegrees(...bounds),
      plain = cloneRectangle(native);
    assert.equal(rectangleWidth(plain), Cesium.Rectangle.computeWidth(native));
    assert.equal(
      rectangleHeight(plain),
      Cesium.Rectangle.computeHeight(native),
    );
    const center = rectangleCenter(plain, {
      longitude: 0,
      latitude: 0,
      height: 123,
    });
    const expected = Cesium.Rectangle.center(native);
    assert.deepEqual(center, {
      longitude: expected.longitude,
      latitude: expected.latitude,
      height: expected.height,
    });
    assert.notEqual(plain, native);
    assert.deepEqual(plain, {
      west: native.west,
      south: native.south,
      east: native.east,
      north: native.north,
    });
  }
});
