import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  guardDegenerateRotation,
  installRenderRecovery,
  RECOVERY_LIMIT,
  RECOVERY_WINDOW_MS,
} from './renderRecovery.js';

/** Cesium's own Camera.rotate on a camera-shaped object, with no scene behind it. */
function cameraFixture() {
  const camera = Object.create(Cesium.Camera.prototype);
  camera.position = new Cesium.Cartesian3(28_378_137, 0, 0);
  camera.direction = new Cesium.Cartesian3(-1, 0, 0);
  camera.up = new Cesium.Cartesian3(0, 0, 1);
  camera.right = new Cesium.Cartesian3(0, 1, 0);
  camera._adjustOrthographicFrustum = () => {};
  return camera;
}

const pose = (camera) =>
  [camera.position, camera.direction, camera.up, camera.right].map((v) =>
    Cesium.Cartesian3.clone(v),
  );

test("the wheel zoom's own arithmetic hands Camera.rotate a zero axis", () => {
  // What handleZoom computes with the pointer on the centre pixel: the same
  // picked point twice. The dot product rounds below 1, the cross product is 0.
  const picked = Cesium.Cartesian3.fromDegrees(-41.11, -13.37);
  const pickedNormal = Cesium.Cartesian3.normalize(
    picked,
    new Cesium.Cartesian3(),
  );
  const centreNormal = Cesium.Cartesian3.normalize(
    picked,
    new Cesium.Cartesian3(),
  );
  const axis = Cesium.Cartesian3.cross(
    pickedNormal,
    centreNormal,
    new Cesium.Cartesian3(),
  );
  assert.deepEqual([axis.x, axis.y, axis.z], [0, 0, 0]);

  const unguarded = cameraFixture();
  assert.throws(() => unguarded.rotate(axis, 0.01), /not a number/);

  const camera = cameraFixture();
  const before = pose(camera);
  guardDegenerateRotation(camera);
  assert.doesNotThrow(() => camera.rotate(axis, 0.01));
  assert.deepEqual(pose(camera), before);
});

test('an axis or angle that is not finite leaves the camera where it is', () => {
  const camera = cameraFixture();
  const before = pose(camera);
  guardDegenerateRotation(camera);
  camera.rotate(new Cesium.Cartesian3(NaN, 0, 1), 0.01);
  camera.rotate(new Cesium.Cartesian3(Infinity, 0, 1), 0.01);
  camera.rotate(Cesium.Cartesian3.UNIT_Z, NaN);
  camera.rotate(Cesium.Cartesian3.UNIT_Z, Infinity);
  assert.deepEqual(pose(camera), before);
});

test('an ordinary rotation is exactly what Cesium does unguarded', () => {
  const axis = new Cesium.Cartesian3(0.2, -0.5, 0.84);
  const plain = cameraFixture();
  plain.rotate(axis, 0.37);
  plain.rotate(Cesium.Cartesian3.UNIT_Z);

  const camera = cameraFixture();
  const restore = guardDegenerateRotation(camera);
  camera.rotate(axis, 0.37);
  // No angle: Cesium's default amount still applies.
  camera.defaultRotateAmount = plain.defaultRotateAmount;
  camera.rotate(Cesium.Cartesian3.UNIT_Z);
  assert.deepEqual(pose(camera), pose(plain));

  restore();
  assert.equal(Object.hasOwn(camera, 'rotate'), false);
  assert.equal(camera.rotate, Cesium.Camera.prototype.rotate);
});

/** Vector equality as Cesium has it: a recomputed right vector may hold -0. */
function assertPose(camera, expected) {
  pose(camera).forEach((vector, i) =>
    assert.ok(Cesium.Cartesian3.equals(vector, expected[i]), `vector ${i}`),
  );
}

function viewerFixture() {
  const postRender = new Cesium.Event();
  const panels = [];
  const resets = [];
  const camera = cameraFixture();
  const viewer = {
    camera,
    useDefaultRenderLoop: true,
    cesiumWidget: {
      showErrorPanel(title, message, error) {
        panels.push({ title, message, error });
      },
    },
    scene: {
      postRender,
      screenSpaceCameraController: {
        _aggregator: { reset: () => resets.push(true) },
      },
    },
  };
  // What Cesium's loop does when a frame throws.
  const fail = (error = new Error('frame failed')) => {
    viewer.useDefaultRenderLoop = false;
    viewer.cesiumWidget.showErrorPanel('Rendering has stopped.', undefined, error);
  };
  return { viewer, camera, postRender, panels, resets, fail };
}

function quietly(run) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    run();
  } finally {
    console.error = original;
  }
  return logged;
}

test('a stopped render loop restarts from the last drawn pose', () => {
  const { viewer, camera, postRender, panels, resets, fail } = viewerFixture();
  const requests = [];
  installRenderRecovery(viewer, {
    now: () => 0,
    requestRender: (reason) => requests.push(reason),
  });
  postRender.raiseEvent();
  const drawn = pose(camera);

  // The failed frame left the camera unusable.
  camera.position.x = NaN;
  camera.direction.y = NaN;
  const error = new Error('normalized result is not a number');
  const logged = quietly(() => fail(error));

  assert.equal(viewer.useDefaultRenderLoop, true);
  assert.deepEqual(panels, []);
  assertPose(camera, drawn);
  assert.deepEqual(resets, [true]);
  assert.deepEqual(requests, ['render-recovery']);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1], error);
});

test('a frame drawn with a broken camera is not kept as the pose to return to', () => {
  const { viewer, camera, postRender, fail } = viewerFixture();
  installRenderRecovery(viewer, { now: () => 0, requestRender: () => {} });
  postRender.raiseEvent();
  const drawn = pose(camera);
  camera.position.x = NaN;
  postRender.raiseEvent();
  quietly(() => fail());
  assertPose(camera, drawn);
});

test('an error that keeps returning is shown and rendering stays stopped', () => {
  const { viewer, panels, fail } = viewerFixture();
  let at = 0;
  installRenderRecovery(viewer, { now: () => at, requestRender: () => {} });
  quietly(() => {
    for (let i = 0; i < RECOVERY_LIMIT; i++) {
      at += 100;
      fail();
      assert.equal(viewer.useDefaultRenderLoop, true, `restart ${i + 1}`);
    }
    at += 100;
    fail();
  });
  assert.equal(viewer.useDefaultRenderLoop, false);
  assert.equal(panels.length, 1);
  assert.equal(panels[0].title, 'Rendering has stopped.');

  // Once the window has passed, a later, unrelated error is recovered again.
  at += RECOVERY_WINDOW_MS + 1;
  quietly(() => fail());
  assert.equal(viewer.useDefaultRenderLoop, true);
  assert.equal(panels.length, 1);
});

test('a panel shown while the loop is running is left alone', () => {
  const { viewer, panels, resets } = viewerFixture();
  installRenderRecovery(viewer, { now: () => 0, requestRender: () => {} });
  viewer.cesiumWidget.showErrorPanel('Error constructing CesiumWidget.', 'x');
  assert.equal(panels.length, 1);
  assert.deepEqual(resets, []);
});

test('disposing restores the widget and stops recording poses', () => {
  const { viewer, postRender, panels, fail } = viewerFixture();
  const original = viewer.cesiumWidget.showErrorPanel;
  const dispose = installRenderRecovery(viewer, {
    now: () => 0,
    requestRender: () => {},
  });
  assert.equal(postRender.numberOfListeners, 1);
  dispose();
  dispose();
  assert.equal(postRender.numberOfListeners, 0);
  assert.equal(viewer.cesiumWidget.showErrorPanel, original);
  fail();
  assert.equal(viewer.useDefaultRenderLoop, false);
  assert.equal(panels.length, 1);
});

test('an incomplete viewer is refused', () => {
  assert.throws(() => installRenderRecovery({}), TypeError);
});
