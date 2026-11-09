// A hand zooming out stops while the globe is still a fair share of the
// screen, on any screen's shape, rather than leaving it a speck.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { limitZoomOut, zoomOutLimit } from './viewer.js';

// The share of the screen's height the globe spans from `altitude`.
function globeShare(altitude, fovy) {
  const radius = Cesium.Ellipsoid.WGS84.maximumRadius;
  const angular = Math.asin(radius / (radius + altitude));
  return Math.tan(angular) / Math.tan(fovy / 2);
}

test("zooming out stops with the globe 30% of the screen's height across", () => {
  for (const fovy of [Math.PI / 3, 0.4, 0.2]) {
    const limit = zoomOutLimit(fovy);
    assert.ok(Math.abs(globeShare(limit, fovy) - 0.3) < 1e-9, `fovy ${fovy}`);
  }
});

test('a wide screen, whose view is narrower, may zoom out farther', () => {
  assert.ok(zoomOutLimit(0.4) > zoomOutLimit(Math.PI / 3));
  assert.ok(zoomOutLimit(Math.PI / 3) > 20_000_000, 'past the views a link opens');
});

function fakeViewer({ fovy = Math.PI / 3, height = 10_000_000 } = {}) {
  const scene = {
    mode: Cesium.SceneMode.SCENE3D,
    preRender: new Cesium.Event(),
    screenSpaceCameraController: { maximumZoomDistance: Infinity },
  };
  const camera = {
    frustum: { fovy },
    positionCartographic: { height },
  };
  return { scene, camera };
}

test('the limit follows the screen, and holds a camera already past it', () => {
  const viewer = fakeViewer();
  const controller = viewer.scene.screenSpaceCameraController;
  const stop = limitZoomOut(viewer);
  viewer.scene.preRender.raiseEvent();
  assert.equal(controller.maximumZoomDistance, zoomOutLimit(Math.PI / 3));

  // A wider screen narrows the view, and the globe may go farther.
  viewer.camera.frustum.fovy = 0.4;
  viewer.scene.preRender.raiseEvent();
  assert.equal(controller.maximumZoomDistance, zoomOutLimit(0.4));

  // Flown past it, the next zoom out stops there instead of jumping in.
  viewer.camera.positionCartographic.height = zoomOutLimit(0.4) * 2;
  viewer.scene.preRender.raiseEvent();
  assert.equal(controller.maximumZoomDistance, zoomOutLimit(0.4) * 2);

  stop();
  viewer.camera.positionCartographic.height = 0;
  viewer.scene.preRender.raiseEvent();
  assert.equal(controller.maximumZoomDistance, zoomOutLimit(0.4) * 2);
});

test('flat maps keep zooming out unlimited', () => {
  const viewer = fakeViewer();
  const controller = viewer.scene.screenSpaceCameraController;
  limitZoomOut(viewer);
  viewer.scene.preRender.raiseEvent();
  assert.ok(Number.isFinite(controller.maximumZoomDistance));
  viewer.scene.mode = Cesium.SceneMode.SCENE2D;
  viewer.camera.frustum = {};
  viewer.scene.preRender.raiseEvent();
  assert.equal(controller.maximumZoomDistance, Infinity);
});
