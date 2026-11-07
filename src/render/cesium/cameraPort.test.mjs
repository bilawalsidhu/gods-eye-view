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
} from '../conformance/index.js';
import { FRAME_MS, headlessCamera, withVirtualClock } from './cameraGoldens.js';
import { createCesiumCamera } from './camera.js';
import { createCesiumPorts } from './ports.js';
import { cameraOf } from '../rendererOf.js';

/** Records the headless scene cannot answer: they need the query port. */
const QUERY_RECORDS = new Set([
  'project',
  'pickEllipsoid',
  'pickRay',
  'occluded',
]);
/** Commands and records the port does not have yet. */
const MISSING = new Set([]);

const runnable = CAMERA_SCRIPTS.filter((script) =>
  script.steps.every(
    (step) =>
      !MISSING.has(step.do) &&
      !MISSING.has(step.record) &&
      !QUERY_RECORDS.has(step.record),
  ),
).map((script) => `camera.trace.${script.name}`);

const CHECKS = new Set([...runnable, 'camera.flight.callbacks']);

function headlessHarness(clock) {
  return {
    name: 'cesium (headless camera)',
    async create() {
      const { scene } = headlessCamera();
      for (const name of ['preUpdate', 'postUpdate', 'preRender', 'postRender'])
        scene[name] = new Cesium.Event();
      scene.primitives = { add() {}, remove() {} };
      scene.requestRender = () => {};
      clock.now = 0;
      const ports = createCesiumPorts(
        { scene, clock: { currentTime: Cesium.JulianDate.now() } },
        { capabilities: new Set() },
      );
      return {
        camera: ports.camera,
        query: ports.query,
        destroy: () => ports.dispose(),
        frameScene() {
          clock.now += FRAME_MS;
          scene.tweens.update();
          scene.postUpdate.raiseEvent(scene);
        },
      };
    },
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
