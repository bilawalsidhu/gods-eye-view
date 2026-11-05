import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { createCesiumProjector } from './projector.js';
import { createFakeViewer } from './testing/fakeViewer.mjs';

function setup(transform) {
  const viewer = createFakeViewer();
  const calls = [];
  const { projector } = createCesiumProjector(viewer, {
    worldToWindowCoordinates(scene, position, result) {
      calls.push({ scene, position, result });
      return transform ? transform(position, result) : undefined;
    },
  });
  return { viewer, projector, calls };
}

test('worldToWindow returns a fresh geo value or fills result', () => {
  const { viewer, projector, calls } = setup((position, result) => {
    result.x = position.x / 10;
    result.y = 7;
    return result;
  });
  const point = geo.cartesian3.create(100, 0, 0);
  const window = projector.worldToWindow(point);
  assert.ok(!(window instanceof Cesium.Cartesian2), 'leaks a Cesium value');
  assert.deepEqual([window.x, window.y], [10, 7]);
  assert.equal(calls[0].scene, viewer.scene);
  assert.equal(calls[0].position, point);
  const result = geo.cartesian2.create();
  assert.equal(projector.worldToWindow(point, result), result);
  assert.deepEqual([result.x, result.y], [10, 7]);
  assert.notEqual(window, projector.worldToWindow(point), 'fresh per call');
});

test('worldToWindow is undefined when Cesium finds no window position', () => {
  const { projector } = setup(() => undefined);
  const result = geo.cartesian2.create(3, 4);
  assert.equal(
    projector.worldToWindow(geo.cartesian3.create(1, 2, 3), result),
    undefined,
  );
  assert.deepEqual([result.x, result.y], [3, 4]);
});

test('viewProjection is the frustum projection times the view matrix', () => {
  const { viewer, projector } = setup();
  const { camera } = viewer.scene;
  const expected = Cesium.Matrix4.toArray(
    Cesium.Matrix4.multiply(
      camera.frustum.projectionMatrix,
      camera.viewMatrix,
      new Cesium.Matrix4(),
    ),
  );
  const result = new Array(16).fill(0);
  assert.equal(projector.viewProjection(result), result);
  assert.deepEqual(result, expected);
  const fresh = projector.viewProjection();
  assert.ok(Array.isArray(fresh), 'a plain column-major array');
  assert.ok(!(fresh instanceof Cesium.Matrix4));
  assert.deepEqual(fresh, expected);
});

test('horizonVisible uses the WGS84 occluder from the camera position', () => {
  const { viewer, projector } = setup();
  viewer.scene.camera.positionWC = Cesium.Cartesian3.fromDegrees(20, 10, 1e6);
  assert.equal(
    projector.horizonVisible(geo.cartesian3.fromDegrees(20, 10, 0)),
    true,
  );
  assert.equal(
    projector.horizonVisible(geo.cartesian3.fromDegrees(-160, -10, 0)),
    false,
  );
  viewer.scene.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    -160,
    -10,
    1e6,
  );
  assert.equal(
    projector.horizonVisible(geo.cartesian3.fromDegrees(-160, -10, 0)),
    true,
    'follows the camera',
  );
});
