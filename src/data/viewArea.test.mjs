import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createViewArea } from './viewArea.js';

function camera(
  frustum = new Cesium.PerspectiveFrustum({
    fov: Math.PI / 2,
    aspectRatio: 1,
    near: 1,
    far: 10000,
  }),
) {
  return {
    frustum,
    positionWC: new Cesium.Cartesian3(),
    directionWC: new Cesium.Cartesian3(0, 0, -1),
    upWC: new Cesium.Cartesian3(0, 1, 0),
  };
}

test('view area retains a quarter-screen margin, clips outside/behind objects and preserves the camera', () => {
  const view = createViewArea();
  const cam = camera();
  const matrix = Cesium.Matrix4.clone(cam.frustum.projectionMatrix);
  view.update(cam);
  assert.equal(view.contains(new Cesium.Cartesian3(0, 0, -100), 0), true);
  assert.equal(view.contains(new Cesium.Cartesian3(140, 0, -100), 0), true);
  assert.equal(view.contains(new Cesium.Cartesian3(160, 0, -100), 0), false);
  assert.equal(view.contains(new Cesium.Cartesian3(0, 160, -100), 0), false);
  assert.equal(view.contains(new Cesium.Cartesian3(0, 0, 100), 0), false);
  assert.equal(
    view.contains(new Cesium.Cartesian3(0, 0, -11000), 0),
    true,
    'native multi-frustum rendering owns the far distance',
  );
  assert.deepEqual(cam.frustum.projectionMatrix, matrix);
  // A partially overlapping model is warm even when its center is outside.
  assert.equal(view.contains(new Cesium.Cartesian3(160, 0, -100), 10), true);
});

test('view area refreshes immediately on a camera turn and fails open for unknown cameras', () => {
  const view = createViewArea();
  const cam = camera();
  const p = new Cesium.Cartesian3(0, 0, 100);
  view.update(cam);
  assert.equal(view.contains(p, 0), false);
  cam.directionWC.z = 1;
  view.update(cam);
  assert.equal(view.contains(p, 0), true);
  view.update({});
  assert.equal(view.contains(p, 0), true);
});

test('orthographic views expand by the same viewport margin', () => {
  const cam = camera(
    new Cesium.OrthographicOffCenterFrustum({
      left: -100,
      right: 100,
      bottom: -50,
      top: 50,
      near: 1,
      far: 1000,
    }),
  );
  const view = createViewArea();
  view.update(cam);
  assert.equal(view.contains(new Cesium.Cartesian3(140, 70, -100), 0), true);
  assert.equal(view.contains(new Cesium.Cartesian3(151, 0, -100), 0), false);
  assert.equal(view.contains(new Cesium.Cartesian3(0, 76, -100), 0), false);
});
