/**
 * The Cesium port's camera commands against the reference traces: the
 * conformance camera checks run on the port over the same headless camera
 * and virtual clock the traces were recorded with, so a mapping of the
 * contract onto Cesium that differs from the recorder's shows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  CAMERA_SCRIPTS,
  DEFAULT_TOLERANCE,
  runConformance,
  usesInput,
} from '../conformance/index.js';
import {
  FRAME_MS,
  dispatchPointer,
  headlessCamera,
  withVirtualClock,
} from './cameraGoldens.js';
import { createCesiumCamera } from './camera.js';
import { createCesiumPorts } from './ports.js';
import { bindRenderer, cameraOf } from '../rendererOf.js';

/** Records the headless scene cannot answer: they need the query port. */
const QUERY_RECORDS = new Set([
  'project',
  'pickEllipsoid',
  'pickRay',
  'occluded',
]);
/** Commands and records the port does not have yet. */
const MISSING = new Set([]);

const runnable = CAMERA_SCRIPTS.filter(
  (script) =>
    !usesInput(script) &&
    script.steps.every(
      (step) =>
        !MISSING.has(step.do) &&
        !MISSING.has(step.record) &&
        !QUERY_RECORDS.has(step.record),
    ),
).map((script) => `camera.trace.${script.name}`);
/** The scripts that drive the camera by pointer and wheel. */
const INPUT_CHECKS = new Set(
  CAMERA_SCRIPTS.filter(usesInput).map((s) => `camera.trace.${s.name}`),
);

const CHECKS = new Set([
  ...runnable,
  'camera.flight.callbacks',
  'camera.controls.settings',
]);

function headlessHarness(clock, { input = false } = {}) {
  return {
    name: 'cesium (headless camera)',
    async create() {
      const { scene } = headlessCamera({ input });
      for (const name of ['preUpdate', 'postUpdate', 'preRender', 'postRender'])
        scene[name] = new Cesium.Event();
      scene.primitives = { add() {}, remove() {} };
      scene.requestRender = () => {};
      clock.now = 0;
      const capabilities = new Set(['cameraChangeThreshold']);
      const ports = createCesiumPorts(
        { scene, clock: { currentTime: Cesium.JulianDate.now() } },
        { capabilities },
      );
      return {
        capabilities,
        camera: ports.camera,
        query: ports.query,
        destroy: () => ports.dispose(),
        frameScene() {
          clock.now += FRAME_MS;
          scene.tweens.update();
          if (input) scene.screenSpaceCameraController.update();
          scene.preUpdate.raiseEvent(scene);
          scene.postUpdate.raiseEvent(scene);
        },
        scene,
      };
    },
    ...(input
      ? {
          cameraInput: true,
          // The contract's event back as the DOM's, a wheel in lines: at 40
          // px a line, Cesium reads the pixels the script scrolled.
          pointer: (r, type, x, y, extra) =>
            dispatchPointer(r.scene, {
              type,
              position: { x, y },
              endPosition: extra.endPosition,
              button: extra.button ?? 0,
              modifiers: extra.modifiers,
              ...(type === 'wheel'
                ? { wheel: { deltaY: extra.delta, deltaMode: 1 } }
                : {}),
            }),
        }
      : {}),
    frame: async (r) => r.frameScene(),
    now: () => clock.now,
    toEcef: (p) => {
      const e =
        'lon' in p
          ? Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height ?? 0)
          : p;
      return { x: e.x, y: e.y, z: e.z };
    },
    tolerance: DEFAULT_TOLERANCE,
    flightPaths: 'trace',
  };
}

test('the camera port retraces the reference flights, views and frames', async () => {
  assert.ok(runnable.length >= 10, `only ${runnable.length} scripts run`);
  const report = await withVirtualClock((clock) =>
    runConformance(headlessHarness(clock), { only: (id) => CHECKS.has(id) }),
  );
  const failed = report.results.filter((r) => r.status === 'fail');
  assert.deepEqual(
    failed.map((r) => `${r.id}: ${r.detail}`),
    [],
  );
  assert.equal(report.passed, CHECKS.size);
});

test('Cesium’s own controls under the camera port retrace the drags and wheels, each wheel sent back in the input port’s lines', async () => {
  assert.ok(INPUT_CHECKS.size >= 4, `only ${INPUT_CHECKS.size} input scripts`);
  const report = await withVirtualClock((clock) =>
    runConformance(headlessHarness(clock, { input: true }), {
      only: (id) => INPUT_CHECKS.has(id),
    }),
  );
  assert.deepEqual(
    report.results
      .filter((r) => r.status !== 'pass')
      .map((r) => `${r.id}: ${r.status} ${r.detail}`),
    [],
  );
  assert.equal(report.passed, INPUT_CHECKS.size);
});

test('a cancelled flight has let go before its callbacks, so they can fly again', async () => {
  await withVirtualClock(async (clock) => {
    const { scene, camera } = headlessCamera();
    scene.postUpdate = new Cesium.Event();
    scene.requestRender = () => {};
    const port = createCesiumCamera({
      scene,
      camera,
      report: (error) => {
        throw error;
      },
    }).port;
    const seen = [];
    let replacement = null;
    port.flyTo(
      { lon: 0, lat: 0, height: 1e6 },
      {
        durationS: 1,
        onCancel: () => {
          seen.push(['cancelled, flying', port.flying]);
          replacement = port.flyTo(
            { lon: 1, lat: 1, height: 1e6 },
            { durationS: 0.2, onComplete: () => seen.push(['replaced']) },
          );
        },
      },
    );
    port.cancelFlight();
    assert.deepEqual(seen, [['cancelled, flying', false]]);
    assert.ok(port.flying, 'the replacement flies');
    for (let i = 0; i < 30 && port.flying; i++) {
      clock.now += FRAME_MS;
      scene.tweens.update();
    }
    assert.equal(await replacement.done, 'complete');
    assert.deepEqual(seen.at(-1), ['replaced']);

    // Superseded by a new flyTo: the old one's onCancel still runs inside
    // that call, and sees the new flight flying.
    const order = [];
    port.flyTo(
      { lon: 2, lat: 2, height: 1e6 },
      {
        durationS: 1,
        onCancel: () => order.push(['old cancelled', port.flying]),
      },
    );
    port.flyTo({ lon: 3, lat: 3, height: 1e6 }, { durationS: 1 });
    assert.deepEqual(order, [['old cancelled', true]]);
  });
});

function headlessPort() {
  const { scene, camera } = headlessCamera();
  scene.postUpdate = new Cesium.Event();
  scene.requestRender = () => {};
  const port = createCesiumCamera({
    scene,
    camera,
    report: (error) => {
      throw error;
    },
  }).port;
  return { scene, camera, port };
}

test('commands announce themselves first; flights raise flightEnd once each', () => {
  const { port } = headlessPort();
  const seen = [];
  const off = port.onCommand((c) => seen.push(c.kind));
  port.on('flightEnd', () => seen.push('flightEnd'));
  const target = Cesium.Cartesian3.fromDegrees(0, 0, 0);
  port.setView({ destination: { lon: 0, lat: 0, height: 1e6 } });
  port.lookAt(target, { heading: 0, pitch: -0.5, range: 1000 });
  port.release();
  port.flyTo({ lon: 1, lat: 1, height: 1e6 }, { durationS: 1 });
  port.flyToBounds({ center: target, radius: 10 }, { durationS: 1 });
  port.cancelFlight();
  off();
  port.setView({ destination: { lon: 0, lat: 0, height: 1e6 } });
  assert.deepEqual(seen, [
    'setView',
    'lookAt',
    'release',
    'flyTo',
    'flyToBounds',
    'flightEnd',
    'cancelFlight',
    'flightEnd',
  ]);
});

test('endFrame world ends a flight out of a lookAt frame', async () => {
  await withVirtualClock(async (clock) => {
    const { scene, port } = headlessPort();
    const target = Cesium.Cartesian3.fromDegrees(0, 0, 0);
    port.lookAt(target, { heading: 0, pitch: -0.5, range: 1000 });
    assert.equal(port.pose().frameIsIdentity, false);
    const flight = port.flyTo(
      { lon: 1, lat: 1, height: 5000 },
      { durationS: 0.2, endFrame: 'world' },
    );
    for (let i = 0; i < 30 && port.flying; i++) {
      clock.now += FRAME_MS;
      scene.tweens.update();
    }
    assert.equal(await flight.done, 'complete');
    assert.equal(port.pose().frameIsIdentity, true);
  });
});

test('a flight Cesium does not start ends cancelled rather than never', async () => {
  const { camera, port } = headlessPort();
  // Mid scene-mode morph Cesium returns without flying or calling back.
  camera._mode = Cesium.SceneMode.MORPHING;
  const flight = port.flyTo({ lon: 1, lat: 1, height: 1e6 }, { durationS: 1 });
  assert.equal(await flight.done, 'cancelled');
  assert.equal(port.flying, false);
});

test('a Cesium viewer with no renderer bound gets a camera port over its own camera', async () => {
  await withVirtualClock(async () => {
    const { scene, camera } = headlessCamera();
    scene.postUpdate = new Cesium.Event();
    scene.requestRender = () => {};
    const viewer = { scene, camera };
    const port = cameraOf(viewer);
    assert.equal(cameraOf(viewer), port, 'one port per viewer');
    let outcome = null;
    port.flyTo(
      { lon: 2.35, lat: 48.86, height: 1500 },
      { durationS: 0, onComplete: () => (outcome = 'complete') },
    );
    assert.equal(outcome, 'complete');
    const pose = port.pose();
    assert.ok(
      Math.abs(pose.lon - 2.35) < 1e-9 && Math.abs(pose.lat - 48.86) < 1e-9,
    );
    assert.ok(Math.abs(pose.height - 1500) < 1e-6);
    assert.throws(() => cameraOf({ scene, camera: {} }), /no renderer camera/);
  });
});

test('the camera port gives the clock its own tick back as it goes', () => {
  const ownTick = Cesium.Clock.prototype.tick;
  // A viewer with no renderer bound: its port goes when a renderer is bound.
  {
    const { scene, camera } = headlessCamera();
    scene.postUpdate = new Cesium.Event();
    scene.requestRender = () => {};
    const viewer = { scene, camera, clock: new Cesium.Clock() };
    cameraOf(viewer);
    assert.notEqual(viewer.clock.tick, ownTick, 'measured as the tick starts');
    bindRenderer(viewer, {});
    assert.equal(viewer.clock.tick, ownTick, 'its own tick once unbound');
    assert.equal(Object.hasOwn(viewer.clock, 'tick'), false);
  }
  // Wrapped again after the port: disposing leaves the later wrapper, and
  // the port's own part of the tick measures nothing more.
  {
    const { scene, camera } = headlessCamera();
    scene.postUpdate = new Cesium.Event();
    scene.requestRender = () => {};
    const clock = new Cesium.Clock();
    const part = createCesiumCamera({
      scene,
      camera,
      report: () => {},
      widget: { clock },
    });
    const wrapped = clock.tick;
    let later = 0;
    clock.tick = function (...args) {
      later += 1;
      return wrapped.apply(this, args);
    };
    part.dispose();
    let reads = 0;
    const frustum = camera.frustum;
    Object.defineProperty(camera, 'frustum', {
      get: () => {
        reads += 1;
        return frustum;
      },
      configurable: true,
    });
    clock.tick();
    assert.equal(later, 1, 'the later wrapper still runs');
    assert.equal(reads, 0, 'the disposed port reads nothing');
  }
});

test('setFov holds the vertical angle across resizes, and waits for a first one', () => {
  const { scene, camera } = headlessCamera();
  scene.postUpdate = new Cesium.Event();
  scene.requestRender = () => {};
  camera.frustum.aspectRatio = NaN;
  const { port } = createCesiumCamera({ scene, camera, report: () => {} });
  port.setFov({ vertical: 0.5 });
  for (const aspect of [16 / 9, 0.6, 4 / 3]) {
    camera.frustum.aspectRatio = aspect;
    scene.postUpdate.raiseEvent(scene);
    assert.ok(Math.abs(camera.frustum.fovy - 0.5) < 1e-12, `aspect ${aspect}`);
  }
  camera.switchToOrthographicFrustum();
  assert.doesNotThrow(() => port.setFov({ vertical: 0.4 }));
  assert.throws(() => port.setFov({ vertical: Math.PI }), RangeError);
  assert.throws(() => port.setFov({ vertical: NaN }), RangeError);
});

test('setFov(null) gives the angle back: Cesium’s own fov again, kept as Cesium keeps it', () => {
  const { scene, camera } = headlessCamera();
  scene.postUpdate = new Cesium.Event();
  scene.requestRender = () => {};
  camera.frustum.aspectRatio = 16 / 9;
  const own = camera.frustum.fov;
  const { port } = createCesiumCamera({ scene, camera, report: () => {} });
  port.setFov({ vertical: 0.5 });
  port.setFov({ vertical: 0.3 });
  scene.postUpdate.raiseEvent(scene);
  port.setFov(null);
  assert.equal(camera.frustum.fov, own, 'the fov it had before the first hold');
  // Rotated to portrait: Cesium keeps its fov, which is now the vertical
  // angle, rather than the held one.
  camera.frustum.aspectRatio = 9 / 16;
  scene.postUpdate.raiseEvent(scene);
  assert.equal(camera.frustum.fov, own);
  assert.ok(Math.abs(camera.frustum.fovy - own) < 1e-12);
});

test('a pose measures heading, pitch and roll as Cesium does, and leaves the camera as it was', () => {
  const { camera, port } = headlessPort();
  const bits = () =>
    [
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
      camera.rightWC,
      camera.position,
      camera.direction,
      camera.up,
    ].flatMap((v) => [v.x, v.y, v.z]);
  const views = [
    { heading: 0.3, pitch: -0.7, roll: 0 },
    { heading: 5.9, pitch: -Math.PI / 2, roll: 0 },
    { heading: 2.1, pitch: -0.05, roll: 0.4 },
    { heading: 0, pitch: Math.PI / 2 - 1e-5, roll: 0 },
    { heading: 4, pitch: 0.6, roll: 6 },
  ];
  for (const [k, orientation] of views.entries()) {
    port.setView({
      destination: {
        lon: -170 + 70 * k,
        lat: -80 + 40 * k,
        height: 3e3 * 10 ** k,
      },
      orientation,
    });
    if (k === 4)
      camera.lookAtTransform(
        Cesium.Transforms.eastNorthUpToFixedFrame(camera.positionWC),
      );
    const before = bits();
    const pose = port.pose();
    assert.deepEqual(bits(), before, 'the camera is not moved to measure it');
    // Cesium's own reads move the camera there and back three times; the
    // first, heading, is read as the pose reads it.
    const heading = camera.heading;
    const pitch = camera.pitch;
    const roll = camera.roll;
    assert.equal(pose.heading, heading, `heading ${k}`);
    assert.ok(Math.abs(pose.pitch - pitch) < 1e-12, `pitch ${k}`);
    const turn = Math.abs(pose.roll - roll);
    assert.ok(Math.min(turn, 2 * Math.PI - turn) < 1e-12, `roll ${k}`);
  }
});

test('an unmoved camera answers its pose from the last read; any change reads it anew', () => {
  const { camera, port } = headlessPort();
  port.setView({
    destination: { lon: 10, lat: 20, height: 5e5 },
    orientation: { heading: 0.3, pitch: -0.7, roll: 0 },
  });
  // Read as Cesium answers now, without the memo. (Cesium measures heading,
  // pitch and roll by moving the camera there and back, which can change
  // its last bits, so the two are compared to within a whisker.)
  const fresh = () => {
    const carto = cartographic.get.call(camera);
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height,
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
      fovy: camera.frustum.fovy,
      x: camera.positionWC.x,
    };
  };
  const near = (pose) => {
    const want = fresh();
    const got = { ...pose, x: pose.position.x };
    for (const [name, value] of Object.entries(want))
      assert.ok(
        Math.abs(got[name] - value) < 1e-6,
        `${name}: ${got[name]} vs ${value}`,
      );
  };
  // Counts the camera's cartographic position read: an answer from the
  // memo reads none.
  let reads = 0;
  const cartographic = Object.getOwnPropertyDescriptor(
    Cesium.Camera.prototype,
    'positionCartographic',
  );
  Object.defineProperty(camera, 'positionCartographic', {
    get() {
      reads += 1;
      return cartographic.get.call(this);
    },
  });
  const a = port.pose();
  reads = 0;
  // A caller's own objects: changing them changes no later pose.
  a.position.x = 0;
  a.heading = 99;
  const b = port.pose();
  assert.equal(reads, 0, 'answered from the memo');
  assert.notEqual(b, a);
  assert.notEqual(b.position, a.position);
  assert.notEqual(b.heading, 99);
  near(b);
  camera.moveRight(1000);
  near(port.pose());
  camera.twistRight(0.2);
  near(port.pose());
  // Cesium lets right drift a little from direction × up.
  const right = port.pose().right;
  camera.right = Cesium.Cartesian3.add(
    camera.right,
    Cesium.Cartesian3.multiplyByScalar(
      camera.up,
      0.05,
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  const drifted = camera.rightWC.x;
  const after = port.pose().right.x;
  assert.notEqual(after, right.x);
  assert.equal(after, drifted);
  camera.frustum.fov = 0.4;
  assert.ok(Math.abs(port.pose().fovy - camera.frustum.fovy) < 1e-12);
  assert.notEqual(port.pose().fovy, b.fovy);
  camera.lookAtTransform(
    Cesium.Transforms.eastNorthUpToFixedFrame(camera.positionWC),
  );
  assert.equal(port.pose().frameIsIdentity, false);
  near(port.pose());
});

test('followFrame is there only with its capability', () => {
  const { scene, camera } = headlessCamera();
  scene.postUpdate = new Cesium.Event();
  const make = (capabilities) =>
    createCesiumCamera({ scene, camera, report: () => {}, capabilities }).port;
  assert.equal(make(new Set()).followFrame, undefined);
  assert.equal(typeof make(new Set(['followFrame'])).followFrame, 'function');
  assert.equal(typeof make(undefined).followFrame, 'function');
});
