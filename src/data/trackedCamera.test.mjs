import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  applyTrackedCameraFrame,
  clampTrackedCameraPosition,
  trackedDisplayPositionForCamera,
  trackedModelScaleForPixelCap,
} from './trackedCamera.js';

test('tracked camera origin crossing returns to the prior side at the minimum range', () => {
  const camera = {
    position: new Cesium.Cartesian3(0, 500, -300),
    direction: new Cesium.Cartesian3(0, -1, 0),
  };
  const previous = new Cesium.Cartesian3(0, -1000, 600);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), true);
  assert.ok(Cesium.Cartesian3.dot(camera.position, previous) > 0);
  assert.ok(Math.abs(Cesium.Cartesian3.magnitude(camera.position) - 150) < 1e-9);
});

test('tracked camera clamps a too-close approach along the current sight line', () => {
  const camera = {
    position: new Cesium.Cartesian3(0, -80, 0),
    direction: new Cesium.Cartesian3(0, 1, 0),
  };
  const previous = new Cesium.Cartesian3(0, -200, 0);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), true);
  assert.ok(Math.abs(camera.position.x) === 0);
  assert.equal(camera.position.y, -150);
  assert.ok(Math.abs(camera.position.z) === 0);
});

test('tracked camera leaves a safe approach unchanged', () => {
  const camera = {
    position: new Cesium.Cartesian3(0, -800, 500),
    direction: Cesium.Cartesian3.normalize(
      new Cesium.Cartesian3(0, 800, -500),
      new Cesium.Cartesian3(),
    ),
  };
  const previous = Cesium.Cartesian3.clone(camera.position);
  const before = Cesium.Cartesian3.clone(camera.position);
  assert.equal(clampTrackedCameraPosition(camera, previous, 150), false);
  assert.deepEqual(camera.position, before);
});

test('tracked model keeps calibrated scale when it projects below the pixel cap', () => {
  const scale = trackedModelScaleForPixelCap({
    baseScale: 24,
    nativeRadiusM: 1.43,
    rangeM: 1000,
    viewportHeightPx: 800,
    fovyRad: Math.PI / 3,
    maximumPixelSize: 104,
  });
  assert.equal(scale, 24);
});

test('tracked model shrinks smoothly when close enough to exceed the pixel cap', () => {
  const scale = trackedModelScaleForPixelCap({
    baseScale: 24,
    nativeRadiusM: 1.43,
    rangeM: 150,
    viewportHeightPx: 800,
    fovyRad: Math.PI / 3,
    maximumPixelSize: 104,
  });
  const focalLengthPx = 800 / (2 * Math.tan(Math.PI / 6));
  const projectedDiameterPx = (2 * 1.43 * scale * focalLengthPx) / 150;
  assert.ok(scale < 24);
  assert.ok(Math.abs(projectedDiameterPx - 104) < 1e-9);
});

test('tracked camera prefers the already-rendered display cache', () => {
  let callbackReads = 0;
  const cached = new Cesium.Cartesian3(1, 2, 3);
  const entity = {
    gevDisplayPosition: () => cached,
    position: {
      getValue: () => {
        callbackReads += 1;
        return new Cesium.Cartesian3(4, 5, 6);
      },
    },
  };
  const result = trackedDisplayPositionForCamera(
    entity,
    Cesium.JulianDate.now(),
    new Cesium.Cartesian3(),
  );
  assert.deepEqual(result, cached);
  assert.notEqual(result, cached);
  assert.equal(callbackReads, 0);
});

/** Minimal viewer stub: real Cesium math, scripted scene camera. */
function makeTrackedFrameViewer({ entity } = {}) {
  const controller = { inertiaZoom: 0.3, minimumZoomDistance: 1 };
  const viewer = {
    isDestroyed: () => false,
    trackedEntity: entity ?? {},
    clock: { currentTime: Cesium.JulianDate.now() },
    scene: {
      screenSpaceCameraController: controller,
      preUpdate: {
        addEventListener(callback) {
          viewer.__preUpdate = callback;
          return () => { viewer.__preUpdate = null; };
        },
      },
    },
    camera: {
      position: new Cesium.Cartesian3(),
      direction: new Cesium.Cartesian3(0, 0, -1),
      transform: Cesium.Matrix4.IDENTITY,
      lookAtTransformCalls: 0,
      lookAtTransform(transform, offset) {
        this.lookAtTransformCalls += 1;
        Cesium.Cartesian3.clone(offset, this.position);
      },
    },
  };
  return { viewer, controller };
}

test('stable tracked zoom parks inertia at the minimum range and restores it on release', () => {
  const entity = {
    position: { getValue: () => Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 3000) },
  };
  const { viewer, controller } = makeTrackedFrameViewer({ entity });
  const stop = applyTrackedCameraFrame(viewer, entity, new Cesium.Cartesian3(0, -150, -30));

  assert.equal(controller.inertiaZoom, 0, 'zoom inertia is parked while the frame owns the controller');
  assert.equal(controller.minimumZoomDistance, 150, 'minimum tracked range is enforced on the controller');

  // One preUpdate pass frames the tracked entity through the offset.
  viewer.__preUpdate();
  assert.ok(viewer.camera.lookAtTransformCalls >= 1, 'the handoff frame is applied via lookAtTransform');

  // Releasing the last owner restores BOTH original controller values.
  stop();
  assert.equal(controller.inertiaZoom, 0.3);
  assert.equal(controller.minimumZoomDistance, 1);
  assert.equal(viewer.__preUpdate, null, 'the preUpdate listener is removed on release');

  // The disposer is idempotent.
  stop();
  assert.equal(controller.inertiaZoom, 0.3);
});

test('stable tracked zoom keeps inertia parked while another entity still owns the controller', () => {
  const entityA = { position: { getValue: () => Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 3000) } };
  const entityB = { position: { getValue: () => Cesium.Cartesian3.fromDegrees(-97.6, 30.3, 3000) } };
  const { viewer, controller } = makeTrackedFrameViewer({ entity: entityA });
  const stopA = applyTrackedCameraFrame(viewer, entityA, new Cesium.Cartesian3(0, -150, -30));
  viewer.__preUpdate(); // frame A so a later stop path runs
  const stopB = applyTrackedCameraFrame(viewer, entityB, new Cesium.Cartesian3(0, -150, -30));

  stopA();
  assert.equal(controller.inertiaZoom, 0, 'B still owns the controller, so inertia stays parked');
  assert.equal(controller.minimumZoomDistance, 150);
  stopB();
  assert.equal(controller.inertiaZoom, 0.3, 'the last release restores the original value');
  assert.equal(controller.minimumZoomDistance, 1);
});

test('a destroyed viewer or a lost track releases the frame from inside preUpdate', () => {
  const entity = { position: { getValue: () => Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 3000) } };
  const { viewer, controller } = makeTrackedFrameViewer({ entity });
  const stop = applyTrackedCameraFrame(viewer, entity, new Cesium.Cartesian3(0, -150, -30));
  assert.equal(controller.inertiaZoom, 0);

  viewer.trackedEntity = null; // the track was lost
  viewer.__preUpdate();
  assert.equal(controller.inertiaZoom, 0.3, 'release happens inside the callback, no manual stop needed');
  assert.equal(viewer.__preUpdate, null);
  stop(); // must be safe to call afterwards
  assert.equal(controller.inertiaZoom, 0.3);

  // Same for a destroyed viewer.
  const second = { position: { getValue: () => Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 3000) } };
  const { viewer: v2, controller: c2 } = makeTrackedFrameViewer({ entity: second });
  applyTrackedCameraFrame(v2, second, new Cesium.Cartesian3(0, -150, -30));
  v2.isDestroyed = () => true;
  v2.__preUpdate();
  assert.equal(c2.inertiaZoom, 0.3);
});

test('an unresolvable position gives up after the attempt budget and stops cleanly', () => {
  const entity = { position: { getValue: () => null } };
  const { viewer, controller } = makeTrackedFrameViewer({ entity });
  applyTrackedCameraFrame(viewer, entity, new Cesium.Cartesian3(0, -150, -30));

  for (let i = 0; i < 120; i += 1) {
    if (!viewer.__preUpdate) break;
    viewer.__preUpdate();
  }
  assert.equal(viewer.__preUpdate, null, 'the sampler stops after MAX_FRAME_ATTEMPTS unresolvable frames');
  assert.equal(controller.inertiaZoom, 0.3);
});

test('a zero-length viewFrom stops the frame handshake immediately', () => {
  const entity = { position: { getValue: () => Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 3000) } };
  const { viewer, controller } = makeTrackedFrameViewer({ entity });
  applyTrackedCameraFrame(viewer, entity, new Cesium.Cartesian3(0, 0, 0));

  viewer.__preUpdate();
  assert.equal(viewer.__preUpdate, null, 'a degenerate offset cannot frame the camera');
  assert.equal(viewer.camera.lookAtTransformCalls, 0);
  assert.equal(controller.inertiaZoom, 0.3);
});

test('a programmatic zoom through the minimum range is corrected on later frames', () => {
  const entity = { position: { getValue: () => Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 3000) } };
  const { viewer, controller } = makeTrackedFrameViewer({ entity });
  const stop = applyTrackedCameraFrame(viewer, entity, new Cesium.Cartesian3(0, -150, -30));
  viewer.__preUpdate(); // frame
  const framesAfterFrame = viewer.camera.lookAtTransformCalls;

  // Programmatic zoom that lands INSIDE the minimum range (bypasses the
  // controller): position at 60 m from the target origin along -Z (the
  // sight line direction).
  viewer.camera.position = new Cesium.Cartesian3(0, 0, 60);
  viewer.__preUpdate();
  assert.ok(viewer.camera.lookAtTransformCalls > framesAfterFrame, 'the clamp re-issues the look-at');
  assert.ok(Cesium.Cartesian3.magnitude(viewer.camera.position) >= 150 - 1e-6, 'position pushed back to the minimum range');

  stop();
  assert.equal(controller.inertiaZoom, 0.3);
});
