import { GLOBE_VIEW } from './locations.js';
import { projectEarthDiscToViewport } from './celestialRing.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  activeCameraMotionId,
  getActiveCameraMotion,
  initCameraVerbs,
  interruptCameraMotion,
  interruptGlobeRotation,
  interruptCameraMotionIfActive,
  moveCamera,
} from './cameraVerbs.js';
import { getRenderGovernorDiagnostics } from './renderGovernor.js';

const radians = Cesium.Math.toRadians;
const clone = (value) => Cesium.Cartesian3.clone(value);
const longitude = (camera) =>
  Cesium.Cartographic.fromCartesian(camera.positionWC).longitude;
const wrappedAngle = Cesium.Math.negativePiToPi;
const hasRenderHold = () =>
  getRenderGovernorDiagnostics().holds.includes('camera-verb');

function near(actual, expected, tolerance = 1e-10, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected}, received ${actual}`,
  );
}

function pose(camera) {
  return {
    position: clone(camera.positionWC),
    direction: clone(camera.directionWC),
    up: clone(camera.upWC),
  };
}

function samePose(camera, expected) {
  const actual = pose(camera);
  for (const key of ['position', 'direction', 'up']) {
    near(
      Cesium.Cartesian3.distance(actual[key], expected[key]),
      0,
      key === 'position' ? 1e-6 : 1e-10,
      key,
    );
  }
}

function orthonormalBasis(camera) {
  const { directionWC: direction, upWC: up, rightWC: right } = camera;
  for (const vector of [direction, up, right]) {
    near(Cesium.Cartesian3.magnitude(vector), 1, 1e-12, 'unit camera basis');
  }
  near(Cesium.Cartesian3.dot(direction, up), 0, 1e-12);
  near(Cesium.Cartesian3.dot(direction, right), 0, 1e-12);
  near(Cesium.Cartesian3.dot(up, right), 0, 1e-12);
  near(
    Cesium.Cartesian3.distance(
      Cesium.Cartesian3.cross(direction, up, new Cesium.Cartesian3()),
      right,
    ),
    0,
    1e-12,
    'right-handed camera basis',
  );
}

/** Use Cesium itself as an independent oracle for the swept camera path. */
function arcHeights(camera, axis, angle, ellipsoid = Cesium.Ellipsoid.WGS84) {
  const heights = [];
  for (let i = 0; i <= 64; i += 1) {
    const probe = Cesium.Camera.clone(camera);
    probe.rotate(axis, (angle * i) / 64);
    heights.push(ellipsoid.cartesianToCartographic(probe.positionWC).height);
  }
  return heights;
}

/** Camera-space screen coordinates, before FOV/aspect scaling. */
function projection(camera, target = Cesium.Cartesian3.ZERO) {
  const offset = Cesium.Cartesian3.subtract(
    target,
    camera.positionWC,
    new Cesium.Cartesian3(),
  );
  const depth = Cesium.Cartesian3.dot(offset, camera.directionWC);
  return {
    x: Cesium.Cartesian3.dot(offset, camera.rightWC) / depth,
    y: Cesium.Cartesian3.dot(offset, camera.upWC) / depth,
    depth,
  };
}

/** Real Cesium geometry with no renderer, GPU, provider or wall-clock waits. */
function harness(
  t,
  {
    latitude = 15,
    longitudeDeg = 0,
    height = GLOBE_VIEW.heightM,
    heading = 0,
    pitch = -90,
    roll = 0,
    ellipsoid = Cesium.Ellipsoid.WGS84,
    viewportWidth = 1280,
    viewportHeight = 800,
  } = {},
) {
  const realPerformance = globalThis.performance;
  let nowMs = 0;
  globalThis.performance = { now: () => nowMs };
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: viewportWidth,
    clientHeight: viewportHeight,
    width: viewportWidth,
    height: viewportHeight,
  });
  const scene = {
    canvas,
    drawingBufferWidth: viewportWidth,
    drawingBufferHeight: viewportHeight,
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    mapProjection: new Cesium.GeographicProjection(ellipsoid),
    globe: { ellipsoid },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    tweens: [],
    requestRender() {},
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      longitudeDeg,
      latitude,
      height,
      ellipsoid,
    ),
    orientation: {
      heading: radians(heading),
      pitch: radians(pitch),
      roll: radians(roll),
    },
  });
  const viewer = {
    camera,
    scene,
    trackedEntity: undefined,
    trackedEntityChanged: new Cesium.Event(),
    clock: { onTick: new Cesium.Event() },
  };
  const target = Cesium.Cartesian3.fromDegrees(
    longitudeDeg,
    latitude,
    0,
    ellipsoid,
  );
  initCameraVerbs(viewer, () => target);
  t.after(() => {
    interruptCameraMotion('test-cleanup');
    globalThis.performance = realPerformance;
  });
  const tick = (seconds = 0.1) => {
    nowMs += seconds * 1000;
    viewer.clock.onTick.raiseEvent(viewer.clock);
  };
  const finishOnce = () => {
    for (let i = 0; i < 20 && getActiveCameraMotion(); i += 1) tick();
    assert.equal(getActiveCameraMotion(), null, 'once motion must finish');
  };
  return { viewer, camera, canvas, target, tick, finishOnce };
}

for (const [name, sceneMode] of [
  ['2D', Cesium.SceneMode.SCENE2D],
  ['Columbus', Cesium.SceneMode.COLUMBUS_VIEW],
  ['morphing', Cesium.SceneMode.MORPHING],
]) {
  test(`globe rotation refuses ${name} before changing the prior owner`, (t) => {
    const { viewer, camera } = harness(t);
    assert.equal(
      moveCamera({ motion: 'rotate', direction: 'right', mode: 'continuous' })
        .ok,
      true,
    );
    const priorId = activeCameraMotionId();
    const before = pose(camera);
    const transform = Cesium.Matrix4.clone(camera.transform);
    viewer.scene.mode = sceneMode;
    let handoffs = 0;
    let cancellations = 0;
    camera.cancelFlight = () => {
      cancellations += 1;
    };
    for (const mode of ['once', 'continuous']) {
      const result = moveCamera(
        { motion: 'rotate_globe', direction: 'left', mode },
        () => {
          handoffs += 1;
          return { ok: true };
        },
      );
      assert.equal(result.ok, false);
      assert.match(result.error, /3D/);
    }
    assert.equal(handoffs, 0);
    assert.equal(cancellations, 0);
    assert.equal(activeCameraMotionId(), priorId);
    assert.equal(hasRenderHold(), true);
    assert.ok(Cesium.Matrix4.equals(camera.transform, transform));
    samePose(camera, before);
  });

  test(`active globe rotation yields to ${name} without changing the camera`, (t) => {
    const { viewer, camera, tick } = harness(t);
    assert.equal(
      moveCamera({ motion: 'rotate_globe', mode: 'continuous' }).ok,
      true,
    );
    viewer.scene.mode = sceneMode;
    const before = pose(camera);
    let rotations = 0;
    camera.rotate = () => {
      rotations += 1;
    };
    tick();
    assert.equal(rotations, 0);
    assert.equal(getActiveCameraMotion(), null);
    assert.equal(hasRenderHold(), false);
    samePose(camera, before);
  });
}

test('globe rotation yields to tracking acquired and cleared before the next tick', (t) => {
  const { viewer, camera, tick } = harness(t);
  assert.equal(
    moveCamera({ motion: 'rotate_globe', mode: 'continuous' }).ok,
    true,
  );
  const before = pose(camera);
  const entity = { id: 'cockpit-aircraft', position: {} };
  viewer.trackedEntity = entity;
  viewer.trackedEntityChanged.raiseEvent(entity);
  assert.equal(
    getActiveCameraMotion(),
    null,
    'tracking acquisition must synchronously yield',
  );
  viewer.trackedEntity = undefined;
  viewer.trackedEntityChanged.raiseEvent(undefined);
  tick();
  samePose(camera, before);
  assert.equal(hasRenderHold(), false);
});

test('tracking event keeps legacy yaw and an untracked globe rotation active', (t) => {
  const { viewer } = harness(t);
  assert.equal(
    moveCamera({ motion: 'rotate', direction: 'right', mode: 'continuous' }).ok,
    true,
  );
  const yawId = activeCameraMotionId();
  viewer.trackedEntityChanged.raiseEvent({ id: 'aircraft' });
  assert.equal(activeCameraMotionId(), yawId);
  assert.equal(
    moveCamera({ motion: 'rotate_globe', mode: 'continuous' }).ok,
    true,
  );
  const globeId = activeCameraMotionId();
  viewer.trackedEntityChanged.raiseEvent(undefined);
  assert.equal(activeCameraMotionId(), globeId);
});

test('replaced viewer releases the old tracking listener without duplicate subscriptions', (t) => {
  const first = harness(t);
  assert.equal(first.viewer.trackedEntityChanged.numberOfListeners, 1);
  initCameraVerbs(first.viewer);
  assert.equal(first.viewer.trackedEntityChanged.numberOfListeners, 1);
  const next = harness(t);
  assert.equal(first.viewer.trackedEntityChanged.numberOfListeners, 0);
  assert.equal(next.viewer.trackedEntityChanged.numberOfListeners, 1);
  assert.equal(
    moveCamera({ motion: 'rotate_globe', mode: 'continuous' }).ok,
    true,
  );
  const id = activeCameraMotionId();
  first.viewer.trackedEntityChanged.raiseEvent({ id: 'stale-aircraft' });
  assert.equal(activeCameraMotionId(), id);
  next.viewer.trackedEntityChanged.raiseEvent({ id: 'new-aircraft' });
  assert.equal(getActiveCameraMotion(), null);
  assert.equal(hasRenderHold(), false);
});

for (const latitude of [0, 30, -60, 89.5]) {
  test(`globe rotation preserves Earth framing and radius from latitude ${latitude} degrees`, (t) => {
    const { camera, tick, finishOnce } = harness(t, { latitude });
    const before = projection(camera);
    const radius = Cesium.Cartesian3.magnitude(camera.positionWC);
    const direction = clone(camera.directionWC);
    const started = moveCamera({ motion: 'rotate_globe', mode: 'once' });
    assert.equal(started.ok, true);
    assert.equal(started.direction, 'right');
    assert.equal(started.mode, 'once');
    for (let i = 0; i < 5; i += 1) {
      tick();
      const current = projection(camera);
      near(current.x, before.x);
      near(current.y, before.y);
      near(current.depth, before.depth, 1e-6);
      near(Cesium.Cartesian3.magnitude(camera.positionWC), radius, 1e-6);
      orthonormalBasis(camera);
    }
    finishOnce();
    near(
      Cesium.Cartesian3.angleBetween(camera.directionWC, direction),
      radians(15),
    );
    assert.equal(hasRenderHold(), false);
  });
}

for (const [direction, sign] of [
  ['left', -1],
  ['right', 1],
]) {
  test(`globe ${direction} means visible landmark motion ${direction}`, (t) => {
    const { camera, target, finishOnce } = harness(t, { latitude: 0 });
    const originalLongitude = longitude(camera);
    near(projection(camera, target).x, 0);
    assert.equal(
      moveCamera({ motion: 'rotate_globe', direction, mode: 'once' }).ok,
      true,
    );
    finishOnce();
    assert.ok(sign * projection(camera, target).x > 0.05);
    near(
      wrappedAngle(longitude(camera) - originalLongitude),
      -sign * radians(15),
    );
  });
}

for (const view of [
  { label: 'north-up', heading: 0 },
  { label: 'east-up', heading: 90 },
  { label: 'south-up', heading: 180 },
  { label: 'tilted east-up', heading: 90, pitch: -86 },
  { label: 'tilted and rolled', heading: 180, pitch: -86, roll: 35 },
  { label: 'near the pole', latitude: 89.5, heading: 180, roll: -25 },
]) {
  for (const [direction, sign] of [
    ['left', -1],
    ['right', 1],
  ]) {
    test(`globe ${direction} stays screen-horizontal in a ${view.label} view`, (t) => {
      const { camera, tick, finishOnce } = harness(t, view);
      const ray = new Cesium.Ray(
        clone(camera.positionWC),
        clone(camera.directionWC),
      );
      const intersection = Cesium.IntersectionTests.rayEllipsoid(
        ray,
        Cesium.Ellipsoid.WGS84,
      );
      assert.ok(intersection, 'the original screen center must see the globe');
      const landmark = Cesium.Ray.getPoint(
        ray,
        intersection.start,
        new Cesium.Cartesian3(),
      );
      const before = projection(camera);
      const radius = Cesium.Cartesian3.magnitude(camera.positionWC);
      const originalLandmark = projection(camera, landmark);
      near(originalLandmark.x, 0);
      near(originalLandmark.y, 0);
      // Exercise both bounded and continuous application of the same direction.
      const mode = direction === 'left' ? 'once' : 'continuous';
      assert.equal(
        moveCamera({ motion: 'rotate_globe', direction, mode }).ok,
        true,
      );
      if (mode === 'once') finishOnce();
      else {
        tick();
        tick(0.25);
      }
      const after = projection(camera);
      const movedLandmark = projection(camera, landmark);
      assert.ok(
        sign * movedLandmark.x > 0.001,
        'landmark must move in the requested screen direction',
      );
      near(movedLandmark.y, originalLandmark.y);
      near(after.x, before.x);
      near(after.y, before.y);
      near(after.depth, before.depth, 1e-6);
      near(Cesium.Cartesian3.magnitude(camera.positionWC), radius, 1e-6);
      orthonormalBasis(camera);
    });
  }
}

test('equal left and right globe rotations restore the complete camera pose', (t) => {
  const { camera, finishOnce } = harness(t, {
    latitude: 42,
    longitudeDeg: 170,
    height: GLOBE_VIEW.heightM,
  });
  const before = pose(camera);
  moveCamera({ motion: 'rotate_globe', direction: 'right', mode: 'once' });
  finishOnce();
  moveCamera({ motion: 'rotate_globe', direction: 'left', mode: 'once' });
  finishOnce();
  samePose(camera, before);
});

test('globe rotation converts an inherited target frame without zooming or recentering', (t) => {
  const { camera, target, tick } = harness(t);
  camera.lookAt(
    target,
    new Cesium.HeadingPitchRange(radians(35), radians(-35), 50_000_000),
  );
  assert.equal(
    Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY),
    false,
  );
  const before = pose(camera);
  const screen = projection(camera);
  const range = Cesium.Cartesian3.magnitude(camera.positionWC);
  moveCamera({
    motion: 'rotate_globe',
    direction: 'right',
    mode: 'continuous',
  });
  assert.equal(
    Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY),
    true,
  );
  samePose(camera, before);
  tick();
  tick();
  near(Cesium.Cartesian3.magnitude(camera.positionWC), range, 1e-6);
  near(projection(camera).x, screen.x);
  near(projection(camera).y, screen.y);
});

for (const [speed, degreesPerSecond] of [
  ['slow', 4],
  ['normal', 10],
  ['fast', 20],
]) {
  test(`continuous globe rotation honors ${speed} speed and explicit stop`, (t) => {
    const { camera, tick } = harness(t);
    const result = moveCamera({
      motion: 'rotate_globe',
      mode: 'continuous',
      speed,
    });
    assert.equal(result.ok, true);
    assert.equal(hasRenderHold(), true);
    tick(); // First tick initializes the motion's wall-clock anchor.
    const before = clone(camera.directionWC);
    tick(0.1);
    near(
      Cesium.Cartesian3.angleBetween(camera.directionWC, before),
      radians(degreesPerSecond * 0.1),
    );
    assert.equal(getActiveCameraMotion()?.kind, 'rotate_globe');
    const stopped = moveCamera({ motion: 'stop' });
    assert.equal(stopped.stopped, true);
    assert.equal(hasRenderHold(), false);
    const after = pose(camera);
    tick();
    samePose(camera, after);
    assert.equal(moveCamera({ motion: 'stop' }).stopped, false);
  });
}

for (const event of ['pointerdown', 'touchstart', 'wheel']) {
  test(`${event} immediately cancels globe rotation and releases the render hold`, (t) => {
    const { camera, canvas, tick } = harness(t);
    moveCamera({ motion: 'rotate_globe', mode: 'continuous' });
    tick();
    tick();
    const before = pose(camera);
    canvas.dispatchEvent(new Event(event));
    assert.equal(getActiveCameraMotion(), null);
    assert.equal(hasRenderHold(), false);
    tick();
    samePose(camera, before);
  });
}

test('new navigation can cancel globe rotation before setting a new destination', (t) => {
  const { camera, tick } = harness(t);
  moveCamera({ motion: 'rotate_globe', mode: 'continuous' });
  tick();
  assert.equal(interruptCameraMotion('explicit-navigation').wasActive, true);
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(110, -25, 1_000_000),
  });
  const destination = pose(camera);
  tick();
  samePose(camera, destination);
  assert.equal(hasRenderHold(), false);
});

test('replacement motion rejects a stale globe owner cancellation', (t) => {
  const { camera, tick } = harness(t);
  moveCamera({ motion: 'rotate_globe', mode: 'continuous' });
  const globeId = activeCameraMotionId();
  moveCamera({ motion: 'rotate', direction: 'left', mode: 'continuous' });
  const yawId = activeCameraMotionId();
  assert.notEqual(yawId, globeId);
  assert.equal(interruptCameraMotionIfActive(globeId).wasActive, false);
  assert.equal(getActiveCameraMotion()?.kind, 'rotate');
  const position = clone(camera.positionWC);
  tick();
  tick();
  near(Cesium.Cartesian3.distance(camera.positionWC, position), 0, 1e-6);
  assert.equal(interruptCameraMotionIfActive(yawId).wasActive, true);
  assert.equal(hasRenderHold(), false);
});

test('replacing the viewer retires globe motion and its old clock listener', (t) => {
  const { viewer, camera, tick } = harness(t);
  assert.equal(
    moveCamera({ motion: 'rotate_globe', mode: 'continuous' }).ok,
    true,
  );
  tick();
  const before = pose(camera);
  const nextViewer = {
    ...viewer,
    clock: { onTick: new Cesium.Event() },
  };
  initCameraVerbs(nextViewer);
  assert.equal(getActiveCameraMotion(), null);
  assert.equal(hasRenderHold(), false);
  tick();
  nextViewer.clock.onTick.raiseEvent(nextViewer.clock);
  samePose(camera, before);
});

for (const direction of ['up', 'down', 'diagonal']) {
  test(`invalid globe direction ${direction} is refused before camera authority handoff`, (t) => {
    const { camera } = harness(t);
    const before = pose(camera);
    let handoffs = 0;
    const result = moveCamera({ motion: 'rotate_globe', direction }, () => {
      handoffs += 1;
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /left or right/);
    assert.equal(handoffs, 0);
    assert.equal(getActiveCameraMotion(), null);
    assert.equal(hasRenderHold(), false);
    samePose(camera, before);
  });
}

for (const mode of ['once', 'continuous']) {
  for (const acquisition of ['tracking', 'reference frame']) {
    test(`globe ${mode} yields to new ${acquisition} without moving the new owner`, (t) => {
      const { viewer, camera, target, tick } = harness(t);
      assert.equal(moveCamera({ motion: 'rotate_globe', mode }).ok, true);
      tick();
      tick();
      assert.equal(hasRenderHold(), true);
      const tracked = { id: 'new-tracked-aircraft' };
      if (acquisition === 'tracking') viewer.trackedEntity = tracked;
      else
        camera.lookAt(
          target,
          new Cesium.HeadingPitchRange(radians(35), radians(-40), 1_000),
        );
      const before = pose(camera);
      const transform = Cesium.Matrix4.clone(camera.transform);
      tick();
      assert.equal(getActiveCameraMotion(), null);
      assert.equal(hasRenderHold(), false);
      assert.equal(
        viewer.trackedEntity,
        acquisition === 'tracking' ? tracked : undefined,
      );
      assert.equal(Cesium.Matrix4.equals(camera.transform, transform), true);
      samePose(camera, before);
      tick();
      samePose(camera, before);
    });
  }
}

test('direct globe rotation refuses a tracked camera without disturbing its reference frame', (t) => {
  const { viewer, camera, target } = harness(t);
  viewer.trackedEntity = { id: 'tracked-aircraft' };
  camera.lookAt(target, new Cesium.HeadingPitchRange(0, radians(-40), 1_000));
  const before = pose(camera);
  const transform = Cesium.Matrix4.clone(camera.transform);
  const result = moveCamera({ motion: 'rotate_globe' });
  assert.equal(result.ok, false);
  assert.match(result.error, /following tracked-aircraft/);
  assert.equal(Cesium.Matrix4.equals(camera.transform, transform), true);
  samePose(camera, before);
  assert.equal(getActiveCameraMotion(), null);
  assert.equal(hasRenderHold(), false);
});

test('the existing Globe View preset remains unchanged', () => {
  assert.deepEqual(GLOBE_VIEW, {
    heightM: 18_000_000,
    pitchDeg: -90,
    durationS: 2.8,
  });
});
for (const latitude of [0, 90, -90])
  for (const height of [12_500_000, 18_000_000, 30_000_000])
    test(`whole-globe admission depends on framing at latitude ${latitude}, height ${height}m`, (t) => {
      const { camera, finishOnce } = harness(t, { latitude, height });
      const radius = Cesium.Cartesian3.magnitude(camera.positionWC);
      assert.equal(
        moveCamera({ motion: 'rotate_globe', direction: 'left', mode: 'once' })
          .ok,
        true,
      );
      finishOnce();
      near(Cesium.Cartesian3.magnitude(camera.positionWC), radius, 1e-6);
    });
test('polar preset admission keeps centre-distance although geodetic altitude varies', (t) => {
  const { camera, tick } = harness(t, { latitude: 90 });
  const radius = Cesium.Cartesian3.magnitude(camera.positionWC);
  assert.ok(Math.min(...arcHeights(camera, camera.upWC, Math.PI * 2)) > 0);
  assert.equal(
    moveCamera({ motion: 'rotate_globe', mode: 'continuous', speed: 'fast' })
      .ok,
    true,
  );
  for (let i = 0; i < 45; i++) tick(0.1);
  assert.ok(
    Cesium.Ellipsoid.WGS84.cartesianToCartographic(camera.positionWC).height <
      GLOBE_VIEW.heightM - 1000,
  );
  assert.equal(getActiveCameraMotion().kind, 'rotate_globe');
  near(Cesium.Cartesian3.magnitude(camera.positionWC), radius, 1e-6);
  moveCamera({ motion: 'stop' });
  assert.equal(hasRenderHold(), false);
});
test('close-up refusal preserves an inherited target frame', (t) => {
  const { camera, target } = harness(t);
  camera.lookAt(target, new Cesium.HeadingPitchRange(0, -0.5, 5000));
  const before = pose(camera),
    transform = Cesium.Matrix4.clone(camera.transform);
  let calls = 0;
  const result = moveCamera({ motion: 'rotate_globe' }, () => {
    calls++;
  });
  assert.equal(
    result.error,
    'Globe rotation isn’t available from this view. You can say ‘Reset to Globe View and rotate the globe.’',
  );
  assert.equal(calls, 0);
  assert.ok(Cesium.Matrix4.equals(camera.transform, transform));
  samePose(camera, before);
});
test('navigation callback never releases tracking for globe rotation', (t) => {
  const { viewer, camera } = harness(t);
  const tracked = (viewer.trackedEntity = { id: 'tracked-aircraft' });
  const before = pose(camera);
  let calls = 0;
  assert.equal(
    moveCamera({ motion: 'rotate_globe' }, () => {
      calls++;
      viewer.trackedEntity = undefined;
    }).ok,
    false,
  );
  assert.equal(calls, 0);
  assert.equal(viewer.trackedEntity, tracked);
  samePose(camera, before);
});
test('direct globe request refuses Cockpit before navigation mutation', (t) => {
  const { viewer, camera } = harness(t);
  initCameraVerbs(viewer, null, { isCockpitActive: () => true });
  const before = pose(camera);
  let calls = 0;
  assert.equal(
    moveCamera({ motion: 'rotate_globe' }, () => {
      calls++;
    }).ok,
    false,
  );
  assert.equal(calls, 0);
  samePose(camera, before);
  assert.equal(hasRenderHold(), false);
});

test('navigation handoff preserves the original world pose even when it levels a rolled camera', (t) => {
  const { camera, tick } = harness(t, {
    latitude: 50,
    heading: 75,
    pitch: -86,
    roll: 35,
  });
  const before = pose(camera);
  const result = moveCamera(
    { motion: 'rotate_globe', mode: 'continuous' },
    (start) => {
      camera.setView({
        orientation: { heading: camera.heading, pitch: camera.pitch, roll: 0 },
      });
      return start();
    },
  );
  assert.equal(result.ok, true);
  samePose(camera, before);
  const screen = projection(camera);
  tick();
  tick();
  near(projection(camera).x, screen.x);
  near(projection(camera).y, screen.y);
  orthonormalBasis(camera);
});

test('direct globe rotation cancels an existing camera flight before acquiring motion', (t) => {
  const { camera } = harness(t);
  let cancellations = 0;
  const original = camera.cancelFlight;
  camera.cancelFlight = function () {
    cancellations += 1;
    return original.call(this);
  };
  const before = pose(camera);
  assert.equal(moveCamera({ motion: 'rotate_globe' }).ok, true);
  assert.equal(cancellations, 1);
  samePose(camera, before);
});

test('legacy rotate remains local yaw at an unchanged camera position', (t) => {
  const { camera, finishOnce } = harness(t, { latitude: 0 });
  const before = pose(camera);
  moveCamera({ motion: 'rotate', direction: 'right' });
  finishOnce();
  near(Cesium.Cartesian3.distance(camera.positionWC, before.position), 0, 1e-6);
  near(
    Cesium.Cartesian3.angleBetween(camera.directionWC, before.direction),
    radians(15),
  );
  assert.ok(
    Math.abs(projection(camera).x) > 0.2,
    'local yaw intentionally moves Earth out of the center',
  );
});

test('legacy orbit still revolves around the selected ground target', (t) => {
  const { camera, target, tick } = harness(t);
  camera.lookAt(target, new Cesium.HeadingPitchRange(0, radians(-45), 4_000));
  camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  const range = Cesium.Cartesian3.distance(camera.positionWC, target);
  moveCamera({ motion: 'orbit', direction: 'right', mode: 'continuous' });
  tick();
  tick();
  assert.equal(getActiveCameraMotion()?.kind, 'orbit');
  near(Cesium.Cartesian3.distance(camera.positionWC, target), range, 1e-6);
  near(projection(camera, target).x, 0);
  near(projection(camera, target).y, 0);
  interruptCameraMotion('test-stop');
  assert.equal(
    Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY),
    true,
  );
});

// Actual UI/tool authority routes, not a direct call to the interrupt helper.
test('new UI navigation intent stops globe motion before its destination and stale ticks', async (t) => {
  const { NavigationController } = await import('./ui/navigationController.js');
  const { viewer, camera, tick } = harness(t);
  const navigation = new NavigationController({
    viewer,
    tracking: {
      flightsLayer: {},
      militaryFlightsLayer: {},
      satellitesLayer: {},
    },
    interruptCameraMotion(reason) {
      assert.equal(
        getActiveCameraMotion(),
        null,
        'the intent stamp must retire rotation before release',
      );
      return interruptCameraMotion(reason);
    },
    interruptGlobeRotation,
    isCockpitActive: () => false,
    cancelOrientation() {},
    clearLocation() {},
    cancelShareSelection: () => false,
    getDataManager: () => null,
    stopOrbit() {},
    showToast() {},
  });
  assert.equal(
    moveCamera({ motion: 'rotate_globe', mode: 'continuous' }).ok,
    true,
  );
  navigation._runExplicitNavigation('camera', () => {
    assert.equal(getActiveCameraMotion(), null);
    assert.equal(hasRenderHold(), false);
  });
  const after = pose(camera);
  tick();
  samePose(camera, after);
});
test('orbit-toggle controller stops globe motion before toggling', async (t) => {
  const { LocationNavigation } = await import('./ui/locationNavigation.js');
  const { target } = harness(t);
  let toggled = false;
  moveCamera({ motion: 'rotate_globe', mode: 'continuous' });
  LocationNavigation.prototype._toggleOrbit.call({
    services: { interruptGlobeRotation },
    _currentTarget: target,
    _currentPoi: {},
    orbitController: {
      toggle() {
        assert.equal(getActiveCameraMotion(), null);
        assert.equal(hasRenderHold(), false);
        toggled = true;
        return true;
      },
    },
    _orbitIndicator: { classList: { toggle() {} } },
  });
  assert.equal(toggled, true);
});
for (const owner of ['tracking', 'cockpit', 'close-up'])
  test(`actual voice runner refuses ${owner} without releasing or repositioning`, async (t) => {
    const { createGevActionRunner } = await import('./voice/gevActions.js');
    const { runExplicitNavigation } = await import('./navigationPolicy.js');
    const { viewer, camera } = harness(t, {
      height: owner === 'close-up' ? 5000 : GLOBE_VIEW.heightM,
    });
    const before = pose(camera);
    if (owner === 'tracking') viewer.trackedEntity = { id: 'tracked-aircraft' };
    const tracked = viewer.trackedEntity;
    let releases = 0,
      stamps = 0;
    const styleManager = {
      getCockpitState: () => ({ active: owner === 'cockpit' }),
      runImmediateNavigation(noun, navigate) {
        return runExplicitNavigation({
          cockpitActive: owner === 'cockpit',
          noun,
          stamp() {
            stamps++;
          },
          release() {
            releases++;
            viewer.trackedEntity = undefined;
          },
          navigate,
        });
      },
    };
    const runner = createGevActionRunner({
      viewer,
      styleManager,
      dataManager: {
        layers: new Map(),
        isEnabled: () => false,
        getAll: () => [],
      },
    });
    const result = await runner('move_camera', {
      motion: 'rotate_globe',
      direction: 'left',
    });
    assert.equal(result.ok, false);
    assert.equal(releases, 0);
    assert.equal(stamps, 0);
    assert.equal(viewer.trackedEntity, tracked);
    samePose(camera, before);
    if (owner === 'close-up') {
      assert.equal(result.reason, 'globe-view-required');
      assert.equal(
        result.error,
        'Globe rotation isn’t available from this view. You can say ‘Reset to Globe View and rotate the globe.’',
      );
    }
  });

for (const [label, ellipsoid] of [
  ['nonfinite radii', { minimumRadius: 1, maximumRadius: Infinity }],
  ['nonpositive radii', { minimumRadius: 0, maximumRadius: 1 }],
  ['non-WGS84 radii', new Cesium.Ellipsoid(30_000_000, 30_000_000, 1_000_000)],
])
  test(`globe rotation refuses ${label} before handoff`, (t) => {
    const { viewer, camera } = harness(t, { height: 100_000_000 });
    const before = pose(camera);
    viewer.scene.globe.ellipsoid = ellipsoid;
    let handedOff = false;
    const result = moveCamera({ motion: 'rotate_globe' }, () => {
      handedOff = true;
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.reason,
      label === 'non-WGS84 radii' ? 'unsupported-view' : 'unsafe-ellipsoid',
    );
    assert.equal(handedOff, false);
    assert.equal(hasRenderHold(), false);
    samePose(camera, before);
  });

test('an external radius change retires globe rotation without another write', (t) => {
  const { camera, tick } = harness(t);
  moveCamera({ motion: 'rotate_globe', mode: 'continuous' });
  camera.moveForward(1000);
  const changed = pose(camera);
  tick();
  assert.equal(getActiveCameraMotion(), null);
  assert.equal(hasRenderHold(), false);
  samePose(camera, changed);
});

test('a non-WGS84 ellipsoid fails closed rather than borrowing the WGS84 silhouette', (t) => {
  const ellipsoid = new Cesium.Ellipsoid(10_000_000, 10_000_000, 8_000_000);
  const { camera } = harness(t, { ellipsoid, latitude: 60 });
  const before = pose(camera);
  const result = moveCamera({ motion: 'rotate_globe' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported-view');
  samePose(camera, before);
});

test('untouched polar framing permits repeated direction and speed changes below preset altitude', (t) => {
  const { camera, finishOnce, tick } = harness(t, { latitude: 90 });
  const radius = Cesium.Cartesian3.magnitude(camera.positionWC);
  assert.equal(
    moveCamera({ motion: 'rotate_globe', direction: 'right', mode: 'once' }).ok,
    true,
  );
  finishOnce();
  assert.ok(
    Cesium.Cartographic.fromCartesian(camera.positionWC).height <
      GLOBE_VIEW.heightM - 1,
  );
  assert.equal(
    moveCamera({ motion: 'rotate_globe', direction: 'right', mode: 'once' }).ok,
    true,
  );
  finishOnce();
  assert.equal(
    moveCamera({
      motion: 'rotate_globe',
      direction: 'left',
      speed: 'fast',
      mode: 'continuous',
    }).ok,
    true,
  );
  tick();
  tick();
  assert.equal(getActiveCameraMotion().speed, 'fast');
  near(Cesium.Cartesian3.magnitude(camera.positionWC), radius, 1e-6);
  assert.equal(moveCamera({ motion: 'stop' }).stopped, true);
});

function projected(h) {
  return projectEarthDiscToViewport(
    h.viewer,
    h.canvas.clientWidth,
    h.canvas.clientHeight,
  );
}

test('a smaller globe wholly inside the keyhole needs no overlay entry margin or reset', (t) => {
  const h = harness(t, { latitude: 0, height: 12_500_000 });
  const disc = projected(h);
  const clearance =
    disc.keyholeRadius -
    Math.hypot(
      disc.earthCenterX - disc.keyholeCenterX,
      disc.earthCenterY - disc.keyholeCenterY,
    ) -
    disc.earthRadius;
  assert.ok(
    clearance > 0 && clearance < 24,
    `near-edge inside fit: ${clearance}`,
  );
  assert.equal(moveCamera({ motion: 'rotate_globe' }).ok, true);
});

test('keyhole overlap refuses without a camera handoff or pose change', (t) => {
  const h = harness(t, { latitude: 0, height: 11_000_000 });
  const before = pose(h.camera);
  const disc = projected(h);
  assert.ok(disc.earthRadius > disc.keyholeRadius);
  let handoffs = 0;
  const result = moveCamera({ motion: 'rotate_globe' }, () => {
    handoffs++;
  });
  assert.equal(result.reason, 'globe-view-required');
  assert.equal(
    result.error,
    'Globe rotation isn’t available from this view. You can say ‘Reset to Globe View and rotate the globe.’',
  );
  assert.equal(handoffs, 0);
  samePose(h.camera, before);
});

for (const [angle, fits] of [
  [5, true],
  [25, false],
])
  test(`actual off-centre globe at ${angle} degrees has fit ${fits}`, (t) => {
    const h = harness(t, { height: 30_000_000 });
    h.camera.lookRight(radians(angle));
    const before = pose(h.camera);
    assert.equal(moveCamera({ motion: 'rotate_globe' }).ok, fits);
    samePose(h.camera, before);
  });

test('wide viewport uses vertical fovy rather than horizontal fov', (t) => {
  const h = harness(t, {
    viewportWidth: 2000,
    viewportHeight: 500,
    latitude: 0,
  });
  assert.ok(h.camera.frustum.fovy < h.camera.frustum.fov);
  assert.ok(projected(h).earthRadius > projected(h).keyholeRadius);
  assert.equal(
    moveCamera({ motion: 'rotate_globe' }).reason,
    'globe-reset-unavailable',
  );
});

for (const invalid of [
  'orthographic',
  'behind',
  'zero-css-width',
  'offset-frustum',
])
  test(`unsupported ${invalid} fails without a reset offer`, (t) => {
    const h = harness(t);
    if (invalid === 'orthographic')
      h.camera.frustum = new Cesium.OrthographicFrustum({
        width: 50_000_000,
        aspectRatio: 1.6,
      });
    if (invalid === 'behind') h.camera.lookRight(Math.PI);
    if (invalid === 'zero-css-width') h.canvas.clientWidth = 0;
    if (invalid === 'offset-frustum') h.camera.frustum.xOffset = 0.1;
    const result = moveCamera({ motion: 'rotate_globe' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported-view');
  });

test('a new request rechecks close-up framing rather than using previous eligibility', (t) => {
  const h = harness(t);
  assert.equal(
    moveCamera({ motion: 'rotate_globe', mode: 'continuous' }).ok,
    true,
  );
  h.canvas.dispatchEvent(new Event('wheel'));
  h.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(0, 0, 5000) });
  const before = pose(h.camera);
  assert.equal(
    moveCamera({ motion: 'rotate_globe' }).reason,
    'globe-view-required',
  );
  samePose(h.camera, before);
  assert.equal(getActiveCameraMotion(), null);
});

// Exact WGS84 equatorial tangent points expose the shared disc approximation.
// Keep the concrete counterexample public; an overlay approximation is not admission proof.
test('off-axis ellipsoid limb overlap must not be admitted as a fully framed globe', (t) => {
  const h = harness(t, { latitude: 0, height: 18_000_000 });
  h.camera.lookRight(radians(6));
  const disc = projected(h);
  assert.ok(
    disc.earthRadius +
      Math.hypot(
        disc.earthCenterX - disc.keyholeCenterX,
        disc.earthCenterY - disc.keyholeCenterY,
      ) <
      disc.keyholeRadius,
    'the shared approximation reports a fit',
  );
  const radius = Cesium.Ellipsoid.WGS84.maximumRadius;
  const x = (radius * radius) / h.camera.positionWC.x;
  const y = Math.sqrt(radius * radius - x * x);
  const limbRadii = [-y, y].map((value) => {
    const pixel = Cesium.SceneTransforms.worldToWindowCoordinates(
      h.viewer.scene,
      new Cesium.Cartesian3(x, value, 0),
    );
    return Math.hypot(
      pixel.x - disc.keyholeCenterX,
      pixel.y - disc.keyholeCenterY,
    );
  });
  assert.ok(
    Math.max(...limbRadii) > disc.keyholeRadius,
    'an actual ellipsoid tangent point overlaps the keyhole',
  );
  assert.equal(moveCamera({ motion: 'rotate_globe' }).ok, false);
});

for (const roll of [0, 35])
  test(`off-axis boundary overlap is refused with roll ${roll}`, (t) => {
    const h = harness(t, { latitude: 0, height: 18_000_000, roll });
    h.camera.lookRight(radians(6));
    const result = moveCamera({ motion: 'rotate_globe' });
    assert.equal(result.reason, 'globe-view-required');
  });

for (const latitude of [0, 90])
  for (const pitch of [0, 15])
    test(`close-up horizon/upward view offers reset at latitude ${latitude}, pitch ${pitch}`, (t) => {
      const h = harness(t, { latitude, pitch, height: 5000 });
      const before = pose(h.camera);
      const result = moveCamera({ motion: 'rotate_globe' });
      assert.equal(result.reason, 'globe-view-required');
      assert.equal(
        result.error,
        'Globe rotation isn’t available from this view. You can say ‘Reset to Globe View and rotate the globe.’',
      );
      samePose(h.camera, before);
    });

for (const [viewportWidth, viewportHeight, fits] of [
  [390, 844, true],
  [844, 390, true],
  [800, 1200, true],
  [1280, 800, true],
  [3440, 1440, false],
])
  test(`unchanged reset preset is rechecked at ${viewportWidth}x${viewportHeight}`, (t) => {
    const h = harness(t, {
      viewportWidth,
      viewportHeight,
      height: GLOBE_VIEW.heightM,
      latitude: 0,
    });
    const disc = projected(h);
    assert.equal(
      disc.earthRadius < disc.keyholeRadius,
      fits,
      'reset preset keyhole fit',
    );
    const before = pose(h.camera);
    const result = moveCamera({ motion: 'rotate_globe' });
    assert.equal(result.ok, fits);
    if (!fits) assert.equal(result.reason, 'globe-reset-unavailable');
    samePose(h.camera, before);
  });

test('keyhole overlap after resize stops rotation before another pose write', (t) => {
  const h = harness(t);
  assert.equal(
    moveCamera({ motion: 'rotate_globe', mode: 'continuous' }).ok,
    true,
  );
  h.canvas.clientWidth = 2000;
  h.canvas.clientHeight = 500;
  h.camera.frustum.aspectRatio = 4;
  assert.ok(projected(h).earthRadius > projected(h).keyholeRadius);
  const before = pose(h.camera);
  h.tick();
  assert.equal(getActiveCameraMotion(), null);
  assert.equal(hasRenderHold(), false);
  samePose(h.camera, before);
});

for (const clipped of ['near', 'far', 'entirely-beyond-far'])
  test(`depth-${clipped} globe is unsupported without a reset offer`, (t) => {
    const h = harness(t, { latitude: 0 });
    const radius = Cesium.Ellipsoid.WGS84.maximumRadius;
    const distance = Cesium.Cartesian3.magnitude(h.camera.positionWC);
    if (clipped === 'near') h.camera.frustum.near = distance - radius + 100;
    if (clipped === 'far') h.camera.frustum.far = distance + radius - 100;
    if (clipped === 'entirely-beyond-far')
      h.camera.frustum.far = distance - 2 * radius;
    const before = pose(h.camera);
    const result = moveCamera({ motion: 'rotate_globe' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported-view');
    samePose(h.camera, before);
    assert.equal(hasRenderHold(), false);
  });

test('fully depth-contained globe remains eligible at actual near/far limits', (t) => {
  const h = harness(t, { latitude: 0 });
  const radius = Cesium.Ellipsoid.WGS84.maximumRadius;
  const distance = Cesium.Cartesian3.magnitude(h.camera.positionWC);
  h.camera.frustum.near = distance - radius - 1;
  h.camera.frustum.far = distance + radius + 1;
  assert.equal(moveCamera({ motion: 'rotate_globe' }).ok, true);
});

for (const [near, far] of [
  [0, 1e9],
  [-1, 1e9],
  [NaN, 1e9],
  [1, Infinity],
  [10, 10],
  [10, 9],
])
  test(`invalid depth limits ${near}/${far} are unsupported`, (t) => {
    const h = harness(t);
    h.camera.frustum.near = near;
    h.camera.frustum.far = far;
    const result = moveCamera({ motion: 'rotate_globe' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unsupported-view');
  });

test('bare globe rotation defaults right and continues beyond a nudge', (t) => {
  const { camera, tick } = harness(t, { latitude: 0 });
  const before = projection(camera);
  const result = moveCamera({ motion: 'rotate_globe' });
  assert.equal(result.ok, true);
  assert.equal(result.direction, 'right');
  assert.equal(result.mode, 'continuous');
  assert.equal(result.speed, 'normal');
  for (let i = 0; i < 30; i++) tick(0.1);
  assert.equal(getActiveCameraMotion().mode, 'continuous');
  near(projection(camera).x, before.x);
  near(projection(camera).y, before.y);
  assert.equal(moveCamera({ motion: 'stop' }).stopped, true);
  assert.equal(hasRenderHold(), false);
});
for (const [args, direction, mode, speed] of [
  [{ mode: 'once' }, 'right', 'once', 'normal'],
  [{ direction: 'left', speed: 'slow' }, 'left', 'continuous', 'slow'],
  [{ direction: 'left', mode: 'once', speed: 'fast' }, 'left', 'once', 'fast'],
  [
    { direction: 'right', mode: 'continuous', speed: 'fast' },
    'right',
    'continuous',
    'fast',
  ],
])
  test(`explicit globe controls prevail: ${JSON.stringify(args)}`, (t) => {
    const { finishOnce, tick } = harness(t);
    const result = moveCamera({ motion: 'rotate_globe', ...args });
    assert.deepEqual(
      [result.ok, result.direction, result.mode, result.speed],
      [true, direction, mode, speed],
    );
    if (mode === 'once') finishOnce();
    else {
      tick();
      tick();
      assert.equal(getActiveCameraMotion().mode, 'continuous');
    }
  });
for (const motion of ['rotate', 'pan', 'tilt', 'orbit'])
  test(`legacy ${motion} retains its once default`, (t) => {
    harness(t);
    const result = moveCamera({
      motion,
      direction: motion === 'tilt' ? 'up' : 'left',
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'once');
  });
for (const mode of [null, '', 'invalid', 'CONTINUOUS'])
  test(`invalid globe mode ${JSON.stringify(mode)} retains legacy once fallback`, (t) => {
    const { finishOnce } = harness(t);
    assert.equal(moveCamera({ motion: 'rotate_globe', mode }).mode, 'once');
    finishOnce();
  });

test('canvas-only clipping after resize preserves a keyhole-fitting rotation', (t) => {
  const h = harness(t, { latitude: 0 });
  assert.equal(moveCamera({ motion: 'rotate_globe' }).ok, true);
  h.canvas.clientWidth = 390;
  h.canvas.clientHeight = 844;
  h.camera.frustum.aspectRatio = 390 / 844;
  const disc = projected(h);
  assert.ok(disc.earthRadius < disc.keyholeRadius);
  assert.ok(disc.earthRadius > h.canvas.clientWidth / 2);
  const before = pose(h.camera);
  h.tick();
  h.tick();
  assert.notDeepEqual(pose(h.camera).position, before.position);
  assert.equal(getActiveCameraMotion()?.kind, 'rotate_globe');
  assert.equal(hasRenderHold(), true);
});

test('an invalid camera request leaves the active globe rotation untouched', (t) => {
  const h = harness(t);
  assert.equal(moveCamera({ motion: 'rotate_globe' }).ok, true);
  const before = pose(h.camera);
  const active = getActiveCameraMotion();
  assert.equal(moveCamera({ motion: 'pan' }).ok, false);
  assert.deepEqual(getActiveCameraMotion(), active);
  samePose(h.camera, before);
  assert.equal(hasRenderHold(), true);
});

test('close-up ultrawide refusal does not offer an unfit reset or move the camera', (t) => {
  const h = harness(t, {
    viewportWidth: 3440,
    viewportHeight: 1440,
    height: 5000,
  });
  const before = pose(h.camera);
  let handoffs = 0;
  const result = moveCamera({ motion: 'rotate_globe' }, () => {
    handoffs++;
  });
  assert.equal(result.reason, 'globe-reset-unavailable');
  assert.equal(handoffs, 0);
  samePose(h.camera, before);
  assert.equal(hasRenderHold(), false);
});
