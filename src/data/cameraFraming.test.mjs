import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';
import { rangeForBoundingSphere } from './cameraFraming.js';

/** The range as it was read from Cesium's frustum before the camera port. */
function rangeFromFrustum(frustum, radius) {
  const verticalFov = frustum.fov;
  const aspectRatio = Math.max(0.5, frustum.aspectRatio);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspectRatio);
  const limitingFov = Math.min(verticalFov, horizontalFov);
  return (radius / Math.sin((limitingFov * 0.57) / 2)) * 1.05;
}

for (const aspectRatio of [16 / 9, 390 / 844, 1]) {
  test(`framing reads the frustum's field of view through the camera port (aspect ${aspectRatio.toFixed(2)})`, () => {
    const frustum = new Cesium.PerspectiveFrustum({
      fov: Math.PI / 3,
      aspectRatio,
      near: 1,
      far: 1e8,
    });
    const viewer = bindFakeCesiumCamera({ camera: { frustum } });
    const range = rangeForBoundingSphere(viewer, 250);
    assert.ok(
      Math.abs(range - rangeFromFrustum(frustum, 250)) < 1e-6,
      `${range} vs ${rangeFromFrustum(frustum, 250)}`,
    );
  });
}

test('framing without a camera assumes a 60 degree square view', () => {
  const expected = rangeFromFrustum({ fov: Math.PI / 3, aspectRatio: 1 }, 100);
  assert.ok(Math.abs(rangeForBoundingSphere({}, 100) - expected) < 1e-9);
});
