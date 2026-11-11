// The camera verbs on the engine-neutral globe contract (the engine rig), on
// the fake engine: pose deltas and durations against a real Cesium camera
// driven through the Cesium engine, cancellation, supersession and the
// release an engine switch makes.

import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import * as geo from './geo/index.js';
import { GLOBE_VIEW } from './locations.js';
import { createFakeEngine } from './globe/testing/fakeEngine.js';
import { createCameraViewer } from './globe/cesium/testing/cameraViewer.mjs';
import {
  activeCameraMotionId,
  cameraVerbsSupported,
  flyRoute,
  getActiveCameraMotion,
  initCameraVerbs,
  interruptCameraMotion,
  moveCamera,
  releaseCameraVerbs,
  resumeRouteFlight,
  suspendRouteFlight,
} from './cameraVerbs.js';
import { getRenderGovernorDiagnostics } from './renderGovernor.js';

const WIDTH = 1280;
const HEIGHT = 800;
const radians = geo.math.toRadians;
const hasRenderHold = (engine) =>
  getRenderGovernorDiagnostics(engine).holds.includes('camera-verb');

/** Wall clock the verbs read (performance.now), moved only by the tests. */
function installClock(t) {
  const real = globalThis.performance;
  const clock = { ms: 0 };
  globalThis.performance = { now: () => clock.ms };
  t.after(() => {
    interruptCameraMotion('test-cleanup');
    globalThis.performance = real;
  });
  return clock;
}

const START = {
  lonDeg: 10,
  latDeg: 30,
  height: 5000,
  headingDeg: 30,
  pitchDeg: -45,
};

/** The fake engine at START (or `pose`), with a DOM-like canvas. */
function engineHarness(t, pose = START, clock = installClock(t)) {
  const engine = createFakeEngine({
    kind: 'navara',
    width: WIDTH,
    height: HEIGHT,
    canvas: new EventTarget(),
  });
  engine.fake.setPose({
    longitude: radians(pose.lonDeg),
    latitude: radians(pose.latDeg),
    height: pose.height,
    heading: radians(pose.headingDeg),
    pitch: radians(pose.pitchDeg),
    roll: 0,
  });
  const frame = (seconds = 0.1) => {
    clock.ms += seconds * 1000;
    engine.fake.frame(seconds * 1000);
  };
  const run = (seconds, step = 0.1) => {
    for (let s = 0; s < seconds - 1e-9; s += step) frame(step);
  };
  return { engine, clock, frame, run, camera: () => engine.camera.pose() };
}

/** The Cesium engine over a real Cesium camera on a stub scene (no renderer). */
function cesiumHarness(t, pose = START, clock = installClock(t)) {
  const {
    viewer,
    scene,
    camera,
    engine,
    frame: turn,
  } = createCameraViewer({
    width: WIDTH,
    height: HEIGHT,
  });
  t.after(() => engine.destroy());
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      pose.lonDeg,
      pose.latDeg,
      pose.height,
    ),
    orientation: {
      heading: radians(pose.headingDeg),
      pitch: radians(pose.pitchDeg),
      roll: 0,
    },
  });
  const frame = (seconds = 0.1) => {
    clock.ms += seconds * 1000;
    turn();
  };
  const run = (seconds, step = 0.1) => {
    for (let s = 0; s < seconds - 1e-9; s += step) frame(step);
  };
  const cameraPose = () => ({
    position: Cesium.Cartesian3.clone(camera.positionWC),
    direction: Cesium.Cartesian3.clone(camera.directionWC),
    up: Cesium.Cartesian3.clone(camera.upWC),
    heading: camera.heading,
    pitch: camera.pitch,
    roll: camera.roll,
  });
  return {
    viewer,
    scene,
    engine,
    camera: cameraPose,
    frame,
    run,
    cesium: camera,
  };
}

function near(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, received ${actual}`,
  );
}

function samePose(actual, expected, label, metres = 1e-3, unit = 1e-9) {
  near(
    geo.cartesian3.distance(actual.position, expected.position),
    0,
    metres,
    `${label} position`,
  );
  near(
    geo.cartesian3.distance(actual.direction, expected.direction),
    0,
    unit,
    `${label} direction`,
  );
  near(geo.cartesian3.distance(actual.up, expected.up), 0, unit, `${label} up`);
}

const ORBIT_TARGET = geo.cartesian3.fromDegrees(10.02, 30.03, 0);

/**
 * Run one verb on the Cesium engine (a real Cesium camera) and on the fake
 * engine from the same pose with the same frames; return both camera poses
 * before and after.
 */
function runOnBoth(t, args, seconds, { pose = START, target = null } = {}) {
  const clock = installClock(t);
  const cesium = cesiumHarness(t, pose, clock);
  initCameraVerbs(cesium.engine, () => target);
  const cesiumBefore = cesium.camera();
  const cesiumResult = moveCamera(args);
  assert.equal(cesiumResult.ok, true, JSON.stringify(cesiumResult));
  cesium.run(seconds);
  const cesiumAfter = cesium.camera();
  interruptCameraMotion('parity');
  releaseCameraVerbs(cesium.engine);

  const fake = engineHarness(t, pose, clock);
  initCameraVerbs(fake.engine, () => target);
  const engineBefore = fake.camera();
  const engineResult = moveCamera(args);
  assert.equal(engineResult.ok, true, JSON.stringify(engineResult));
  fake.run(seconds);
  const engineAfter = fake.camera();
  return {
    cesiumBefore,
    cesiumAfter,
    engineBefore,
    engineAfter,
    cesiumResult,
    engineResult,
    fake,
  };
}

for (const [label, args, seconds] of [
  ['pan left once', { motion: 'pan', direction: 'left' }, 1.2],
  ['pan up once', { motion: 'pan', direction: 'up' }, 1.2],
  [
    'pan right continuous',
    { motion: 'pan', direction: 'right', mode: 'continuous', speed: 'fast' },
    2,
  ],
  ['tilt up once', { motion: 'tilt', direction: 'up' }, 1.2],
  ['tilt down once', { motion: 'tilt', direction: 'down' }, 1.2],
  ['rotate left once', { motion: 'rotate', direction: 'left' }, 1.2],
  [
    'rotate right continuous',
    { motion: 'rotate', direction: 'right', mode: 'continuous' },
    1.5,
  ],
])
  test(`engine rig ${label} lands where the Cesium camera does`, (t) => {
    const run = runOnBoth(t, args, seconds);
    samePose(run.engineBefore, run.cesiumBefore, `${label} start`, 1e-6, 1e-9);
    samePose(run.engineAfter, run.cesiumAfter, label, 1e-3, 1e-8);
    assert.deepEqual(run.engineResult, run.cesiumResult);
  });

test('engine rig orbit revolves around the ground target as Cesium lookAt does', (t) => {
  for (const mode of ['once', 'continuous']) {
    const run = runOnBoth(
      t,
      { motion: 'orbit', direction: 'left', mode },
      1.5,
      {
        target: ORBIT_TARGET,
      },
    );
    samePose(run.engineAfter, run.cesiumAfter, `orbit ${mode}`, 1e-3, 1e-8);
    // Range to the target is held while the heading turns.
    near(
      geo.cartesian3.distance(run.engineAfter.position, ORBIT_TARGET),
      geo.cartesian3.distance(run.engineBefore.position, ORBIT_TARGET),
      1e-3,
      `orbit ${mode} range`,
    );
    interruptCameraMotion('next-mode');
  }
});

test('engine rig globe rotation turns the camera about Earth like Cesium camera.rotate', (t) => {
  const globe = {
    lonDeg: 0,
    latDeg: 15,
    height: GLOBE_VIEW.heightM,
    headingDeg: 0,
    pitchDeg: -90,
  };
  for (const direction of ['left', 'right']) {
    const run = runOnBoth(
      t,
      { motion: 'rotate_globe', direction, mode: 'continuous' },
      1,
      { pose: globe },
    );
    samePose(
      run.engineAfter,
      run.cesiumAfter,
      `globe ${direction}`,
      1e-3,
      1e-8,
    );
    // Radius preserved; normal speed is 10 degrees a second about Earth.
    near(
      geo.cartesian3.magnitude(run.engineAfter.position),
      geo.cartesian3.magnitude(run.engineBefore.position),
      1e-6,
      'radius',
    );
    const turned = geo.cartesian3.angleBetween(
      run.engineAfter.position,
      run.engineBefore.position,
    );
    // Ten frames of 0.1 s: the first one takes the minimum step (1 ms).
    near(geo.math.toDegrees(turned), 10 * 0.901, 1e-4, 'rate');
    interruptCameraMotion('next-direction');
  }
});

test('a once nudge spends its budget in 0.9 s and then lets go', (t) => {
  const { engine, run, camera } = engineHarness(t);
  // No view target: the tilt turns in place. With ground under the crosshair
  // it swings about that point instead (src/cameraTilt.test.mjs).
  initCameraVerbs(engine);
  const before = camera();
  assert.equal(moveCamera({ motion: 'tilt', direction: 'up' }).ok, true);
  assert.equal(hasRenderHold(engine), true);
  run(0.8);
  assert.equal(getActiveCameraMotion()?.kind, 'tilt', 'still easing');
  run(0.2);
  assert.equal(getActiveCameraMotion(), null, 'finished after 0.9 s');
  assert.equal(hasRenderHold(engine), false);
  near(
    geo.math.toDegrees(camera().pitch - before.pitch),
    15,
    1e-6,
    'tilt nudge',
  );
  samePose(
    { ...camera(), direction: before.direction, up: before.up },
    before,
    'tilt keeps the position',
  );
});

test('a finished once orbit releases its lookAt lock', (t) => {
  const { engine, run } = engineHarness(t);
  initCameraVerbs(engine, () => ORBIT_TARGET);
  assert.equal(moveCamera({ motion: 'orbit' }).ok, true);
  run(0.5);
  assert.notDeepEqual(engine.camera.transform(), [...geo.matrix4.IDENTITY]);
  run(1);
  assert.equal(getActiveCameraMotion(), null);
  assert.deepEqual(engine.camera.transform(), [...geo.matrix4.IDENTITY]);
});

test('an orbit started during a flight arms and captures once it settles', (t) => {
  const { engine, run } = engineHarness(t);
  initCameraVerbs(engine, () => ORBIT_TARGET);
  engine.camera.flyTo({
    destination: geo.cartesian3.fromDegrees(10.01, 30, 4000),
    duration: 1,
  });
  const started = moveCamera({ motion: 'orbit', mode: 'continuous' });
  assert.equal(started.armed, 'waiting-for-arrival');
  run(0.5);
  assert.equal(engine.camera.flightActive(), true, 'still flying');
  assert.equal(engine.fake.callsOf('camera.lookAt').length, 0, 'armed');
  run(0.6);
  assert.equal(engine.camera.flightActive(), false, 'flight landed');
  assert.equal(engine.fake.callsOf('camera.lookAt').length, 0, 'still armed');
  run(1.2);
  assert.ok(engine.fake.callsOf('camera.lookAt').length > 0, 'orbiting');
  assert.equal(getActiveCameraMotion()?.kind, 'orbit');
});

test('manual input on the canvas stops the motion and releases the hold', (t) => {
  const { engine, run } = engineHarness(t);
  initCameraVerbs(engine, () => ORBIT_TARGET);
  for (const event of ['pointerdown', 'touchstart', 'wheel']) {
    assert.equal(moveCamera({ motion: 'orbit', mode: 'continuous' }).ok, true);
    run(0.3);
    engine.host.canvas.dispatchEvent(new Event(event));
    assert.equal(getActiveCameraMotion(), null, event);
    assert.equal(hasRenderHold(engine), false, event);
    assert.deepEqual(engine.camera.transform(), [...geo.matrix4.IDENTITY]);
    engine.fake.resetCalls();
    run(0.3);
    assert.equal(engine.fake.callsOf('camera.lookAt').length, 0, event);
  }
});

test('a new verb supersedes the running one and stop ends it', (t) => {
  const { engine, run } = engineHarness(t);
  initCameraVerbs(engine, () => ORBIT_TARGET);
  moveCamera({ motion: 'orbit', mode: 'continuous' });
  const orbitId = activeCameraMotionId();
  run(0.3);
  moveCamera({ motion: 'pan', direction: 'left', mode: 'continuous' });
  assert.notEqual(activeCameraMotionId(), orbitId);
  assert.equal(getActiveCameraMotion().kind, 'pan');
  assert.deepEqual(engine.camera.transform(), [...geo.matrix4.IDENTITY]);
  engine.fake.resetCalls();
  run(0.3);
  assert.equal(engine.fake.callsOf('camera.lookAt').length, 0);
  assert.ok(engine.fake.callsOf('camera.setView').length > 0);
  const stop = moveCamera({ motion: 'stop' });
  assert.deepEqual(stop, {
    ok: true,
    action: 'move_camera',
    motion: 'stop',
    stopped: true,
  });
  assert.equal(hasRenderHold(engine), false);
});

test('one frame listener and three input listeners exist only while a motion runs', (t) => {
  const { engine, run } = engineHarness(t);
  const canvas = engine.host.canvas;
  const added = [];
  const removed = [];
  const add = canvas.addEventListener.bind(canvas);
  const remove = canvas.removeEventListener.bind(canvas);
  canvas.addEventListener = (type, ...rest) => {
    added.push(type);
    add(type, ...rest);
  };
  canvas.removeEventListener = (type, ...rest) => {
    removed.push(type);
    remove(type, ...rest);
  };
  const preRender = engine.frames.preRender;
  const baseline = preRender.numberOfListeners;
  initCameraVerbs(engine, () => ORBIT_TARGET);
  assert.equal(preRender.numberOfListeners, baseline, 'init binds nothing');
  moveCamera({ motion: 'rotate', direction: 'left', mode: 'continuous' });
  assert.equal(preRender.numberOfListeners, baseline + 1);
  moveCamera({ motion: 'rotate', direction: 'right', mode: 'continuous' });
  assert.equal(preRender.numberOfListeners, baseline + 1, 'rebound, not added');
  run(0.2);
  interruptCameraMotion('test');
  assert.equal(preRender.numberOfListeners, baseline);
  assert.deepEqual(added.sort(), removed.sort());
});

test('an engine switch releases the verb: the parked engine is never driven again', (t) => {
  const first = engineHarness(t);
  initCameraVerbs(first.engine, () => ORBIT_TARGET);
  moveCamera({ motion: 'pan', direction: 'right', mode: 'continuous' });
  first.run(0.3);
  // What the Navara scene's suspend does (src/app/scene.js).
  releaseCameraVerbs(first.engine);
  assert.equal(getActiveCameraMotion(), null);
  assert.equal(hasRenderHold(first.engine), false);
  first.engine.fake.resetCalls();
  first.run(0.5);
  assert.equal(first.engine.fake.callsOf('camera.setView').length, 0);
  // Nothing new starts on the released engine.
  const refused = moveCamera({ motion: 'pan', direction: 'left' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'no-camera');

  // The next engine's voice runner installs it; verbs run there only.
  const next = engineHarness(t, START, first.clock);
  initCameraVerbs(next.engine, () => ORBIT_TARGET);
  assert.equal(moveCamera({ motion: 'tilt', direction: 'up' }).ok, true);
  next.run(1);
  first.run(0.5);
  assert.equal(first.engine.fake.callsOf('camera.setView').length, 0);
});

test('installing another camera stops a motion running on the previous one', (t) => {
  const first = engineHarness(t);
  initCameraVerbs(first.engine, () => ORBIT_TARGET);
  moveCamera({ motion: 'orbit', mode: 'continuous' });
  first.run(0.3);
  const cesium = cesiumHarness(t, START, first.clock);
  initCameraVerbs(cesium.engine, () => ORBIT_TARGET);
  assert.equal(getActiveCameraMotion(), null);
  assert.deepEqual(first.engine.camera.transform(), [...geo.matrix4.IDENTITY]);
  releaseCameraVerbs(cesium.engine);
});

test('globe rotation yields when a follow takes the engine camera', (t) => {
  const { engine, run } = engineHarness(t, {
    lonDeg: 0,
    latDeg: 15,
    height: GLOBE_VIEW.heightM,
    headingDeg: 0,
    pitchDeg: -90,
  });
  initCameraVerbs(engine, () => ORBIT_TARGET);
  assert.equal(moveCamera({ motion: 'rotate_globe' }).ok, true);
  run(0.3);
  const target = geo.cartesian3.fromDegrees(0, 15, 10000);
  engine.camera.follow({
    position: () => target,
    viewFrom: geo.cartesian3.create(0, -2000, 1000),
  });
  assert.equal(getActiveCameraMotion(), null);
  assert.equal(hasRenderHold(engine), false);
  // And a request while following is refused before any handoff.
  let handoffs = 0;
  const refused = moveCamera({ motion: 'rotate_globe' }, () => {
    handoffs += 1;
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Already following/);
  assert.equal(handoffs, 0);
});

test('globe rotation from a close-up offers the Globe View reset on the engine', (t) => {
  const { engine } = engineHarness(t);
  initCameraVerbs(engine);
  const before = engine.camera.pose();
  const result = moveCamera({ motion: 'rotate_globe' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'globe-view-required');
  samePose(engine.camera.pose(), before, 'refusal keeps the camera');
});

test('tilt limits are read from the engine pose', (t) => {
  const { engine } = engineHarness(t, { ...START, pitchDeg: -89 });
  initCameraVerbs(engine);
  const result = moveCamera({ motion: 'tilt', direction: 'down' });
  assert.equal(result.ok, false);
  assert.match(result.error, /straight down/);
});

const ROUTE = [
  {
    type: 'route',
    label: 'walk',
    path: [
      { lat: 30, lon: 10 },
      { lat: 30.01, lon: 10 },
      { lat: 30.01, lon: 10.01 },
    ],
  },
];

test('fly_route flies the installed engine camera and lands level', (t) => {
  const { engine, run } = engineHarness(t);
  initCameraVerbs(engine, () => null);
  const result = flyRoute(
    ROUTE,
    { speed: 'fast' },
    () => 0,
    null,
    () => {},
  );
  assert.equal(result.ok, true);
  run(3);
  const mid = getActiveCameraMotion();
  assert.ok(mid.traveledM > 0, 'departed');
  assert.ok(engine.fake.callsOf('camera.setView').length > 0);
  run(result.durationS + 2);
  assert.equal(getActiveCameraMotion(), null, 'landed');
  near(geo.math.negativePiToPi(engine.camera.pose().roll), 0, 1e-5, 'roll');
  assert.equal(hasRenderHold(engine), false);
});

test('a parked route flight resumes on another engine without jumping', (t) => {
  const first = engineHarness(t);
  initCameraVerbs(first.engine, () => null);
  const { motionId } = flyRoute(
    ROUTE,
    {},
    () => 0,
    null,
    () => {},
  );
  first.run(4);
  const parkedAt = getActiveCameraMotion().traveledM;
  const state = suspendRouteFlight(motionId);
  assert.ok(state);
  assert.equal(getActiveCameraMotion(), null);
  const next = engineHarness(t, START, first.clock);
  next.clock.ms += 60_000; // parked for a minute
  assert.equal(resumeRouteFlight(state, next.engine), true);
  next.frame(0.1);
  const resumed = getActiveCameraMotion();
  assert.equal(resumed.motionId, motionId);
  assert.ok(resumed.traveledM - parkedAt < 10, 'no jump across the park');
  first.engine.fake.resetCalls();
  first.run(0.5);
  assert.equal(first.engine.fake.callsOf('camera.setView').length, 0);
});

test('verbs without an installed camera refuse instead of throwing', (t) => {
  installClock(t);
  const engine = createFakeEngine();
  initCameraVerbs(engine);
  releaseCameraVerbs(engine);
  assert.equal(moveCamera({ motion: 'orbit' }).reason, 'no-camera');
  assert.equal(flyRoute(ROUTE).reason, 'no-camera');
});

test('cameraVerbsSupported names the targets the verbs can drive', () => {
  const engine = createFakeEngine();
  assert.equal(cameraVerbsSupported(engine), true);
  assert.equal(cameraVerbsSupported(null), false);
  engine.destroy();
  assert.equal(cameraVerbsSupported(engine), false);
});

test('a once orbit armed through a flight still turns its full nudge', (t) => {
  for (const kind of ['cesium', 'engine']) {
    const clock = installClock(t);
    const target = ORBIT_TARGET;
    let h;
    let flying;
    if (kind === 'engine') {
      h = engineHarness(t, START, clock);
      initCameraVerbs(h.engine, () => target);
      const here = h.camera();
      h.engine.camera.flyTo({
        destination: here.position,
        orientation: { direction: here.direction, up: here.up },
        duration: 1.5,
      });
      flying = true;
    } else {
      // A flight a layer started straight on viewer.camera: a scene tween
      // the engine did not start.
      h = cesiumHarness(t, START, clock);
      initCameraVerbs(h.engine, () => target);
      h.scene.tweens.push({});
      flying = true;
    }
    const before = h.camera();
    assert.equal(moveCamera({ motion: 'orbit' }).armed, 'waiting-for-arrival');
    h.run(1.6);
    if (kind === 'cesium' && flying) h.scene.tweens.length = 0;
    h.run(1);
    const start = getActiveCameraMotion();
    assert.equal(start?.kind, 'orbit', `${kind}: the arm outlived 0.9 s`);
    h.run(1.2);
    assert.equal(getActiveCameraMotion(), null, `${kind}: nudge finished`);
    const after = h.camera();
    near(
      geo.cartesian3.distance(after.position, target),
      geo.cartesian3.distance(before.position, target),
      1e-3,
      `${kind}: range`,
    );
    const turn = geo.math.toDegrees(
      geo.math.negativePiToPi(after.heading - before.heading),
    );
    near(turn, 30, 0.05, `${kind}: heading (camera frame vs target frame)`);
    if (kind === 'cesium') releaseCameraVerbs(h.engine);
  }
});
