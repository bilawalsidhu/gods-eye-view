// The share follow in a follow's own frame: a satellite's is not
// east-north-up, and the eye placed in it must land where Cesium's own
// calls put it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { applyShareFollowOffset, placeFollowEye } from './shareFollow.js';
import { followOffsetToEnu } from '../share/viewCodec.js';
import { withEntityRecord } from '../data/entityRecords.js';
import { entityFollowTarget, followedOf } from '../data/followed.js';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';
import { findCamera, rendererOf } from '../render/rendererOf.js';

function realCamera() {
  const scene = {
    canvas: { clientWidth: 1200, clientHeight: 800, width: 1200, height: 800 },
    drawingBufferWidth: 1200,
    drawingBufferHeight: 800,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    preUpdate: new Cesium.Event(),
    requestRender() {},
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  return { camera, scene };
}

const TARGET = Cesium.Cartesian3.fromDegrees(-97, 30, 400_000);
const START = new Cesium.Cartesian3(900, -1500, 700);

/**
 * An orbit frame at the target, turned away from east-north-up as a
 * satellite's frame from its motion is.
 */
function orbitFrame() {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(TARGET);
  const turn = Cesium.Matrix3.multiply(
    Cesium.Matrix3.fromRotationZ(0.7),
    Cesium.Matrix3.fromRotationX(0.3),
    new Cesium.Matrix3(),
  );
  return Cesium.Matrix4.multiply(
    enu,
    Cesium.Matrix4.fromRotation(turn),
    new Cesium.Matrix4(),
  );
}

/** A real camera following in the orbit frame, its viewer bound to ports. */
function following(start = START) {
  const { camera, scene } = realCamera();
  camera.lookAtTransform(orbitFrame(), start);
  const viewer = {
    camera,
    scene,
    clock: { currentTime: Cesium.JulianDate.now() },
  };
  bindFakeCesiumCamera(viewer, {
    frame: {
      on: (phase, cb) =>
        phase === 'preUpdate' ? scene.preUpdate.addEventListener(cb) : () => {},
    },
  });
  // The port follows the satellite, already framed in its orbit frame; its
  // follow offset is the eye in that frame, as the Cesium follow's is.
  const renderer = rendererOf(viewer);
  const port = renderer.camera;
  const followed = entityFollowTarget(
    withEntityRecord(
      {},
      { trackedId: 'satellites:25544', displayPosition: () => TARGET },
    ),
    { position: () => TARGET, frame: 'autodetect' },
  );
  renderer.camera = Object.create(port, {
    followed: { get: () => followed },
    followFramed: { get: () => true },
    followOffset: {
      value: Object.freeze({
        get() {
          const p = camera.position;
          return { x: p.x, y: p.y, z: p.z };
        },
        set(offset) {
          camera.lookAtTransform(
            camera.transform,
            new Cesium.Cartesian3(offset.x, offset.y, offset.z),
          );
        },
      }),
    },
  });
  return viewer;
}

function samePose(actual, expected) {
  for (const key of ['positionWC', 'directionWC', 'upWC'])
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(
        actual[key],
        expected[key],
        0,
        key === 'positionWC' ? 1e-6 : 1e-9,
      ),
      `${key}: ${actual[key]} vs ${expected[key]}`,
    );
  assert.ok(
    Cesium.Matrix4.equalsEpsilon(actual.transform, expected.transform, 1e-9),
    'the camera stays in the follow frame',
  );
}

const snapshot = (camera) => ({
  positionWC: Cesium.Cartesian3.clone(camera.positionWC),
  directionWC: Cesium.Cartesian3.clone(camera.directionWC),
  upWC: Cesium.Cartesian3.clone(camera.upWC),
  transform: Cesium.Matrix4.clone(camera.transform),
});

for (const [label, offset] of [
  ['oblique', { heading: 0.4, pitch: -0.6, range: 2500 }],
  // The top-down view: angles read off a direction would lose its roll.
  ['straight down', { heading: 0, pitch: -89 * (Math.PI / 180), range: 2500 }],
])
  test(`placing the follow eye keeps an orbit frame and lands where lookAt puts it (${label})`, () => {
    // What Cesium's own calls did: look at the target, then re-enter the
    // follow's frame keeping the world pose.
    const { camera: reference } = realCamera();
    reference.lookAtTransform(orbitFrame(), START);
    const tracked = Cesium.Matrix4.clone(reference.transform);
    reference.lookAt(
      TARGET,
      new Cesium.HeadingPitchRange(offset.heading, offset.pitch, offset.range),
    );
    reference.lookAtTransform(tracked);

    const viewer = following();
    assert.equal(placeFollowEye(viewer, TARGET, offset), true);
    samePose(snapshot(viewer.camera), snapshot(reference));
  });

for (const offset of [
  { range: 1800, heading: 20, pitch: -30 },
  { range: 1800, heading: 20, pitch: -88 },
])
  test(`a shared offset is re-expressed in an orbit frame as Cesium’s own calls did (pitch ${offset.pitch})`, () => {
    const local = followOffsetToEnu(offset);
    // What Cesium's own calls did in one frame: the goal in the follow frame,
    // and the eye looking at its origin from there. The eye starts a little
    // off the goal, so one frame's turn reaches it.
    const world = Cesium.Matrix4.multiplyByPoint(
      Cesium.Transforms.eastNorthUpToFixedFrame(TARGET),
      new Cesium.Cartesian3(local.east, local.north, local.up),
      new Cesium.Cartesian3(),
    );
    const goal = Cesium.Matrix4.multiplyByPoint(
      Cesium.Matrix4.inverseTransformation(orbitFrame(), new Cesium.Matrix4()),
      world,
      new Cesium.Cartesian3(),
    );
    const start = new Cesium.Cartesian3(goal.x * 1.2, goal.y, goal.z * 0.8);
    const { camera: reference } = realCamera();
    reference.lookAtTransform(orbitFrame(), start);
    reference.lookAtTransform(reference.transform, goal);

    const viewer = following(start);
    // The camera port's own listeners stay; the offset's goes on arrival.
    const own = viewer.scene.preUpdate.numberOfListeners;
    applyShareFollowOffset(viewer, followedOf(viewer), offset);
    viewer.scene.preUpdate.raiseEvent();
    viewer.scene.preUpdate.raiseEvent();
    assert.equal(viewer.scene.preUpdate.numberOfListeners, own, 'it arrives');
    samePose(snapshot(viewer.camera), snapshot(reference));
  });

test('placing the follow eye does nothing on a camera that cannot say its frame', () => {
  const viewer = following();
  const port = findCamera(viewer);
  Object.defineProperty(port, 'followFrame', { value: undefined });
  const before = snapshot(viewer.camera);
  assert.equal(
    placeFollowEye(viewer, TARGET, { heading: 0, pitch: -0.5, range: 900 }),
    false,
  );
  samePose(snapshot(viewer.camera), before);
});
