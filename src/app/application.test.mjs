import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createApplication } from './application.js';
import { KEYHOLE_OUTER_RADIUS } from '../celestialRing.js';
import * as Cesium from 'cesium';
import {
  installFreeLookHeightLimit,
  installGlobeInViewRecovery,
  installTrackpadPinchZoom,
} from './viewer.js';
import {
  FREE_LOOK_MAX_HEIGHT_METERS,
  globeFrameShare,
  globeOutOfFrame,
  lookAngleWithinFrame,
  lookStepLosesGlobe,
} from '../globeInView.js';

const phases = ['Scene', 'Controls', 'Data', 'Tools'];
function fixture(overrides = {}) {
  const events = [];
  const constructors = Object.fromEntries(
    phases.map((phase) => [
      `create${phase}`,
      ({ defer }) => {
        events.push(`start:${phase}`);
        defer(() => events.push(`stop:${phase}`));
        return { name: phase };
      },
    ]),
  );
  return { events, app: createApplication({ ...constructors, ...overrides }) };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('importing and constructing the package is inactive without browser globals', () => {
  const result = spawnSync(
    process.execPath,
    [
      // Views are single-file components; Node needs the loader hosts use.
      '--import=gods-eye-view/build/register-vue',
      '--input-type=module',
      '-e',
      `
    globalThis.fetch = () => { throw new Error('unexpected request'); };
    globalThis.setTimeout = () => { throw new Error('unexpected timer'); };
    const { createApplication } = await import('gods-eye-view/application');
    const fail = () => { throw new Error('unexpected construction'); };
    const app = createApplication({ createScene: fail, createControls: fail, createData: fail, createTools: fail });
    if (app.getState().status !== 'created') process.exit(1);
  `,
    ],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('constructors are validated before allocating anything', () => {
  assert.throws(() => createApplication({}), /Missing scene constructor/);
});

test('startup shares one promise and teardown keeps data alive for controls', async () => {
  const { app, events } = fixture({
    createTools({ scene, controls, data, defer }) {
      assert.equal(scene.name, 'Scene');
      assert.equal(controls.name, 'Controls');
      assert.equal(data.name, 'Data');
      defer(() => events.push('stop:Tools'));
      return { name: 'Tools' };
    },
  });
  const states = [];
  app.subscribe((state) => states.push(`${state.status}:${state.phase}`));
  const started = app.start();
  assert.equal(started, app.start());
  const components = await started;
  assert.ok(Object.isFrozen(components));
  assert.equal(components.tools.name, 'Tools');
  assert.equal(app.getState().status, 'ready');
  const stopped = app.destroy();
  assert.equal(stopped, app.destroy());
  await stopped;
  assert.deepEqual(events.slice(-4), [
    'stop:Tools',
    'stop:Controls',
    'stop:Data',
    'stop:Scene',
  ]);
  assert.deepEqual(app.getComponents(), {});
  assert.equal(states.at(-1), 'destroyed:null');
  await assert.rejects(app.start(), /destroyed/);
});

for (const phase of phases) {
  test(`failure during ${phase} releases partially acquired resources`, async () => {
    const { app, events } = fixture({
      [`create${phase}`]({ defer }) {
        defer(() => events.push('partial:released'));
        throw new Error('broken constructor');
      },
    });
    await assert.rejects(app.start(), /broken constructor/);
    assert.equal(
      events.filter((value) => value === 'partial:released').length,
      1,
    );
    assert.equal(app.getState().status, 'failed');
    assert.deepEqual(app.getComponents(), {});
    await app.destroy();
    assert.equal(
      events.filter((value) => value === 'partial:released').length,
      1,
    );
  });
}

test('destroy before startup prevents every constructor', async () => {
  const { app, events } = fixture();
  const started = app.start();
  const failed = assert.rejects(started, { name: 'AbortError' });
  await app.destroy();
  await failed;
  assert.deepEqual(events, []);
});

test('destroy aborts an in-flight constructor and cleans late acquisitions before resolving', async () => {
  const gate = deferred();
  const entered = deferred();
  let observedSignal;
  const { app, events } = fixture({
    async createScene({ signal, defer }) {
      observedSignal = signal;
      entered.resolve();
      await gate.promise;
      defer(() => events.push('late:released'));
      return {};
    },
  });
  const started = app.start();
  const failed = assert.rejects(started, { name: 'AbortError' });
  await entered.promise;
  let settled = false;
  const stopped = app.destroy().then(() => {
    settled = true;
  });
  assert.equal(observedSignal.aborted, true);
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve();
  await stopped;
  await failed;
  assert.deepEqual(events, ['late:released']);
});

test('cleanup errors are reported after all remaining resources are attempted', async () => {
  const { app, events } = fixture({
    createTools({ defer }) {
      defer(() => events.push('tools:earlier'));
      defer(() => {
        throw new Error('dispose failed');
      });
      return {};
    },
  });
  await app.start();
  await assert.rejects(app.destroy(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, 'dispose failed');
    return true;
  });
  assert.deepEqual(events.slice(-4), [
    'tools:earlier',
    'stop:Controls',
    'stop:Data',
    'stop:Scene',
  ]);
  assert.equal(app.getState().status, 'failed');
});

test('subscribers can destroy during startup without allowing the next constructor', async () => {
  const { app, events } = fixture();
  app.subscribe((state) => {
    if (state.phase === 'controls') void app.destroy();
  });
  await assert.rejects(app.start(), { name: 'AbortError' });
  await app.destroy();
  assert.deepEqual(events, ['start:Scene', 'stop:Scene']);
});

test('destroy during ready notification rejects startup and tears everything down', async () => {
  const { app } = fixture();
  app.subscribe((state) => {
    if (state.status === 'ready') void app.destroy();
  });
  await assert.rejects(app.start(), { name: 'AbortError' });
  await app.destroy();
  assert.equal(app.getState().status, 'destroyed');
});

test('cleanup registration closes when a constructor settles', async () => {
  let register;
  const { app } = fixture({
    createScene({ defer }) {
      register = defer;
      return {};
    },
  });
  await app.start();
  assert.throws(() => register(() => {}), /during component construction/);
  await app.destroy();
});

test('different application instances do not share lifecycle state', async () => {
  const first = fixture();
  const second = fixture();
  await Promise.all([first.app.start(), second.app.start()]);
  await first.app.destroy();
  assert.equal(second.app.getState().status, 'ready');
  assert.equal(second.events.length, 4);
  await second.app.destroy();
});

test('the separate viewer export imports without constructing a browser viewer', async () => {
  const { createApplicationViewer } =
    await import('gods-eye-view/application/viewer');
  assert.equal(typeof createApplicationViewer, 'function');
  assert.throws(() => createApplicationViewer({}), /containers are required/);
});

test('the viewer gets the starry sky as an option, which keeps the Sun and Moon', async () => {
  const { applicationViewerOptions } = await import('./viewer.js');
  const { StarrySky } = await import('../sky/starrySky.js');
  const creditContainer = {};
  const options = applicationViewerOptions(creditContainer);
  // CesiumWidget skips scene.sun and scene.moon when skyBox is false.
  assert.ok(options.skyBox instanceof StarrySky);
  assert.equal(options.creditContainer, creditContainer);
  options.skyBox.destroy();
});

function pinchFixture({ zoomEventTypes } = {}) {
  const handlers = new Set();
  const relayed = [];
  const container = {
    addEventListener(type, handler, options) {
      assert.equal(type, 'wheel');
      assert.deepEqual(options, { capture: true, passive: false });
      handlers.add(handler);
    },
    removeEventListener(type, handler, capture) {
      assert.equal(type, 'wheel');
      assert.equal(capture, true);
      handlers.delete(handler);
    },
    emit(event) {
      for (const handler of handlers) handler(event);
    },
  };
  const canvas = {
    dispatchEvent(event) {
      // A real canvas dispatch crosses the container's capture listener again.
      container.emit(event);
      relayed.push(event);
      return true;
    },
  };
  const controller = { zoomEventTypes };
  const viewer = {
    container,
    canvas,
    scene: { screenSpaceCameraController: controller },
  };
  const createEvent = (init = {}) => ({
    deltaX: 0,
    deltaY: 0,
    deltaZ: 0,
    deltaMode: 0,
    screenX: 0,
    screenY: 0,
    clientX: 0,
    clientY: 0,
    ctrlKey: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...init,
  });
  return { viewer, controller, container, handlers, relayed, createEvent };
}

test('trackpad pinch adds the Ctrl+wheel binding without replacing Cesium inputs', () => {
  const original = [1, 2, 3];
  const f = pinchFixture({ zoomEventTypes: original });
  const dispose = installTrackpadPinchZoom(f.viewer, {
    createWheelEvent: (_type, init) => f.createEvent(init),
  });
  assert.deepEqual(f.controller.zoomEventTypes.slice(0, 3), original);
  assert.equal(f.controller.zoomEventTypes.length, 4);

  const plain = f.createEvent({ deltaY: 2 });
  f.container.emit(plain);
  assert.equal(plain.defaultPrevented, false);
  const lineMode = f.createEvent({ ctrlKey: true, deltaY: 2, deltaMode: 1 });
  f.container.emit(lineMode);
  assert.equal(lineMode.defaultPrevented, false);
  assert.equal(f.relayed.length, 0);

  dispose();
  dispose();
  assert.equal(f.controller.zoomEventTypes, original);
  assert.equal(f.handlers.size, 0);
});

test('trackpad pinch relays pixel deltas once with bounded amplification', () => {
  const f = pinchFixture({ zoomEventTypes: [1, 2, 3] });
  installTrackpadPinchZoom(f.viewer, {
    createWheelEvent: (_type, init) => f.createEvent(init),
  });

  const small = f.createEvent({ ctrlKey: true, deltaY: 2 });
  f.container.emit(small);
  assert.equal(small.defaultPrevented, true);
  assert.equal(small.propagationStopped, true);
  assert.equal(f.relayed.length, 1);
  assert.equal(f.relayed[0].deltaY, 16);
  assert.equal(f.relayed[0].ctrlKey, true);

  const large = f.createEvent({ ctrlKey: true, deltaY: -100 });
  f.container.emit(large);
  assert.equal(f.relayed.length, 2);
  assert.equal(f.relayed[1].deltaY, -120);
});

test('trackpad pinch falls back to the original event when relay construction fails', () => {
  const f = pinchFixture({ zoomEventTypes: [1, 2, 3] });
  installTrackpadPinchZoom(f.viewer, {
    createWheelEvent() {
      throw new Error('unsupported');
    },
  });
  const event = f.createEvent({ ctrlKey: true, deltaY: 2 });
  f.container.emit(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.propagationStopped, false);
  assert.equal(f.relayed.length, 0);
});

function freeLookFixture({ enableLook = true, height = 0 } = {}) {
  const listeners = new Set();
  const controller = { enableLook, minimumTrackBallHeight: 7_500_000 };
  const camera = { positionCartographic: { height } };
  const viewer = {
    camera,
    scene: {
      screenSpaceCameraController: controller,
      preUpdate: {
        addEventListener(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  };
  const frame = (nextHeight) => {
    camera.positionCartographic = { height: nextHeight };
    for (const listener of listeners) listener();
  };
  return { viewer, controller, listeners, frame };
}

test('free look follows camera height and is restored on dispose', () => {
  const f = freeLookFixture({ height: 500 });
  const dispose = installFreeLookHeightLimit(f.viewer);
  assert.equal(f.controller.enableLook, true);

  f.frame(FREE_LOOK_MAX_HEIGHT_METERS + 1);
  assert.equal(f.controller.enableLook, false);
  f.frame(FREE_LOOK_MAX_HEIGHT_METERS);
  assert.equal(f.controller.enableLook, true);
  f.frame(Number.NaN);
  assert.equal(f.controller.enableLook, true);

  f.frame(FREE_LOOK_MAX_HEIGHT_METERS * 20);
  dispose();
  dispose();
  assert.equal(f.controller.enableLook, true);
  assert.equal(f.listeners.size, 0);
});

test('drags that start on the stars orbit above the free-look height', () => {
  // Below Cesium's trackball height such a drag turns the camera in place.
  const f = freeLookFixture({ height: 500 });
  const dispose = installFreeLookHeightLimit(f.viewer);
  assert.equal(
    f.controller.minimumTrackBallHeight,
    FREE_LOOK_MAX_HEIGHT_METERS,
  );
  dispose();
  assert.equal(f.controller.minimumTrackBallHeight, 7_500_000);

  const lower = freeLookFixture({ height: 500 });
  lower.controller.minimumTrackBallHeight = 500_000;
  const disposeLower = installFreeLookHeightLimit(lower.viewer);
  assert.equal(
    lower.controller.minimumTrackBallHeight,
    500_000,
    'never raised',
  );
  disposeLower();
  assert.equal(lower.controller.minimumTrackBallHeight, 500_000);

  const later = freeLookFixture({ height: 500 });
  const disposeLater = installFreeLookHeightLimit(later.viewer);
  later.controller.minimumTrackBallHeight = 2_000_000;
  disposeLater();
  assert.equal(
    later.controller.minimumTrackBallHeight,
    2_000_000,
    'dispose keeps a value set after install',
  );
});

test('free look keeps a setting other code makes after it is installed', () => {
  const f = freeLookFixture({ height: 500 });
  const dispose = installFreeLookHeightLimit(f.viewer);
  f.controller.enableLook = false;
  f.frame(10);
  assert.equal(f.controller.enableLook, false, 'turned off stays off');
  f.frame(FREE_LOOK_MAX_HEIGHT_METERS * 20);
  f.frame(10);
  assert.equal(f.controller.enableLook, false, 'and stays off after orbit');
  f.controller.enableLook = true;
  f.frame(10);
  assert.equal(f.controller.enableLook, true, 'turned back on');
  f.frame(FREE_LOOK_MAX_HEIGHT_METERS * 20);
  assert.equal(f.controller.enableLook, false, 'still limited from orbit');
  f.frame(10);
  f.controller.enableLook = false;
  dispose();
  assert.equal(f.controller.enableLook, false, 'dispose keeps a later setting');
});

test('free look stays off when the viewer had it disabled', () => {
  const f = freeLookFixture({ enableLook: false, height: 500 });
  installFreeLookHeightLimit(f.viewer);
  f.frame(10);
  assert.equal(f.controller.enableLook, false);
});

// A real Cesium camera on the smallest scene its constructor reads, so the
// frustum test runs on Cesium's own view math rather than a stub.
function realCamera({ width = 1600, height = 900, mode } = {}) {
  const scene = {
    canvas: { clientWidth: width, clientHeight: height },
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    mapProjection: new Cesium.GeographicProjection(),
    mode: mode ?? Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    ellipsoid: Cesium.Ellipsoid.WGS84,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    tweens: new Cesium.TweenCollection(),
    renders: 0,
    requestRender() {
      this.renders += 1;
    },
  };
  const camera = new Cesium.Camera(scene);
  camera.frustum.aspectRatio = width / height;
  return { camera, scene, viewer: { camera, scene } };
}

function aim(
  camera,
  { lon = -94.69, lat = 18.87, alt, heading = 0, pitch, roll = 0 },
) {
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
    orientation: {
      heading: Cesium.Math.toRadians(heading),
      pitch: Cesium.Math.toRadians(pitch),
      roll: Cesium.Math.toRadians(roll),
    },
  });
}

const reportedStuckView = {
  alt: 17_996_811,
  heading: 180,
  pitch: -42,
  roll: 180,
};
// Oblique poses that still show part of the planet: Director recipe shots
// (Global Flights Radar, Omniscience Pullback) and a voice tilt from orbit.
const partialGlobeViews = [
  { lon: -30, lat: 20, alt: 19_000_000, pitch: -65 },
  { lon: 2, lat: 46, alt: 8_000_000, pitch: -52 },
  { lon: 110, lat: 20, alt: 9_500_000, pitch: -66 },
  { lon: 0, lat: 0, alt: 2_000_000, pitch: -30 },
];

// Stars and a few pixels of limb, no surface: where a frame limit measured
// against a sphere of the planet's largest radius used to stop a voice tilt.
const limbOnlyView = { alt: 18_000_000, pitch: -56.75 };

/**
 * An oracle independent of the code under test: the share of an 80×45 grid of
 * Cesium pick rays across the canvas that hit the ellipsoid surface.
 */
function surfacePixelShare(camera, width, height, { keyhole = false } = {}) {
  const radius = (KEYHOLE_OUTER_RADIUS * height) / 2;
  let hits = 0;
  let counted = 0;
  for (let row = 0; row < 45; row += 1) {
    for (let column = 0; column < 80; column += 1) {
      const x = ((column + 0.5) * width) / 80;
      const y = ((row + 0.5) * height) / 45;
      if (keyhole && Math.hypot(x - width / 2, y - height / 2) > radius)
        continue;
      counted += 1;
      const ray = camera.getPickRay(new Cesium.Cartesian2(x, y));
      if (Cesium.IntersectionTests.rayEllipsoid(ray, Cesium.Ellipsoid.WGS84))
        hits += 1;
    }
  }
  return hits / counted;
}

test('the globe is out of frame only when no surface is on screen', () => {
  const cases = [
    [reportedStuckView, 1225, 923, true],
    [limbOnlyView, 1600, 900, true],
    [{ alt: 17_996_811, pitch: -90 }, 1225, 923, false],
    ...partialGlobeViews.map((view) => [view, 1600, 900, false]),
  ];
  for (const [view, width, height, out] of cases) {
    const { camera } = realCamera({ width, height });
    aim(camera, view);
    const label = JSON.stringify(view);
    assert.equal(globeOutOfFrame(camera), out, label);
    assert.equal(surfacePixelShare(camera, width, height) === 0, out, label);
    assert.ok(
      Math.abs(
        globeFrameShare(camera) - surfacePixelShare(camera, width, height),
      ) < 0.03,
      `${label}: the frame share matches the pick-ray oracle`,
    );
  }
});

test('a move that ends with the globe out of frame turns back to nadir', () => {
  const { camera, scene, viewer } = realCamera({ width: 1225, height: 923 });
  const dispose = installGlobeInViewRecovery(viewer);
  aim(camera, reportedStuckView);
  const position = Cesium.Cartesian3.clone(camera.positionWC);
  const heading = camera.heading;
  camera.moveEnd.raiseEvent();
  assert.ok(Cesium.Math.equalsEpsilon(camera.pitch, -Math.PI / 2, 1e-6));
  assert.ok(Cesium.Math.equalsEpsilon(camera.heading, heading, 1e-6));
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(camera.positionWC, position, 0, 1e-3),
  );
  assert.equal(globeOutOfFrame(camera), false);
  assert.equal(scene.renders, 1);

  // Looking up near the ground, then zoomed out past the limit.
  aim(camera, { alt: 3_834_000, pitch: 10 });
  camera.moveEnd.raiseEvent();
  assert.ok(Cesium.Math.equalsEpsilon(camera.pitch, -Math.PI / 2, 1e-6));

  // Only the limb on a 16:9 screen still counts as lost.
  const wide = realCamera({ width: 1600, height: 900 });
  const disposeWide = installGlobeInViewRecovery(wide.viewer);
  aim(wide.camera, limbOnlyView);
  wide.camera.moveEnd.raiseEvent();
  assert.ok(Cesium.Math.equalsEpsilon(wide.camera.pitch, -Math.PI / 2, 1e-6));
  disposeWide();

  dispose();
  dispose();
  aim(camera, reportedStuckView);
  camera.moveEnd.raiseEvent();
  assert.equal(globeOutOfFrame(camera), true, 'disposed recovery is inert');
});

// True when a moveEnd leaves the camera's view direction as it was.
function moveEndKeepsView(camera) {
  const direction = Cesium.Cartesian3.clone(camera.directionWC);
  camera.moveEnd.raiseEvent();
  return Cesium.Cartesian3.equalsEpsilon(camera.directionWC, direction, 1e-9);
}

test('globe recovery leaves partial, low, locked and 2D views alone', () => {
  for (const view of partialGlobeViews) {
    const { camera, viewer } = realCamera();
    installGlobeInViewRecovery(viewer);
    aim(camera, view);
    assert.ok(moveEndKeepsView(camera), JSON.stringify(view));
  }

  const low = realCamera();
  installGlobeInViewRecovery(low.viewer);
  aim(low.camera, { alt: 900_000, pitch: 85 });
  assert.equal(globeOutOfFrame(low.camera), true);
  assert.ok(moveEndKeepsView(low.camera), 'below the limit');

  // Locked on a point in space, between it and the planet, facing away.
  const locked = realCamera();
  installGlobeInViewRecovery(locked.viewer);
  locked.camera.lookAtTransform(
    Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(30_000_000, 0, 0)),
    new Cesium.Cartesian3(-1_000_000, 0, 0),
  );
  assert.equal(globeOutOfFrame(locked.camera), true);
  assert.ok(moveEndKeepsView(locked.camera), 'locked camera');

  // Tracking an entity that has no position yet keeps an identity transform.
  const tracked = realCamera();
  tracked.viewer.trackedEntity = { id: 'pending-fix' };
  installGlobeInViewRecovery(tracked.viewer);
  aim(tracked.camera, reportedStuckView);
  assert.ok(moveEndKeepsView(tracked.camera), 'tracked camera');

  const flat = realCamera({ mode: Cesium.SceneMode.COLUMBUS_VIEW });
  installGlobeInViewRecovery(flat.viewer);
  flat.scene.mode = Cesium.SceneMode.SCENE3D;
  aim(flat.camera, reportedStuckView);
  flat.scene.mode = Cesium.SceneMode.COLUMBUS_VIEW;
  assert.ok(moveEndKeepsView(flat.camera), 'Columbus view');
});

test('the look limit from orbit tolerates grid noise and never reaches zero', () => {
  const radians = Cesium.Math.toRadians;
  // About 2% of a 16:9 frame on the planet, below the 10% limit.
  const sliver = { alt: 18_000_000, pitch: -60 };
  const { camera } = realCamera();
  aim(camera, sliver);
  const start = surfacePixelShare(camera, 1600, 900);
  assert.ok(start > 0 && start < 0.1, `starts below the limit: ${start}`);

  // Sideways across the sliver: the share wobbles by a cell, the planet stays.
  assert.equal(lookStepLosesGlobe(camera, 'lookLeft', radians(0.5)), false);
  const startShare = globeFrameShare(camera);
  for (let i = 0; i < 20; i += 1) {
    const step = lookAngleWithinFrame(camera, 'lookLeft', radians(0.25), {
      startShare,
    });
    assert.equal(step, radians(0.25), `sideways step ${i + 1}`);
    camera.lookLeft(step);
  }
  assert.ok(surfacePixelShare(camera, 1600, 900) > 0);

  // Toward the planet is always allowed.
  aim(camera, sliver);
  assert.equal(
    lookAngleWithinFrame(camera, 'lookDown', radians(10)),
    radians(10),
  );

  // Away from it stops short of losing it.
  aim(camera, sliver);
  const away = lookAngleWithinFrame(camera, 'lookUp', radians(30));
  assert.ok(away < radians(30));
  camera.lookUp(away);
  assert.ok(globeFrameShare(camera) > 0);
  assert.ok(surfacePixelShare(camera, 1600, 900) > 0);
});

test('the look limit leaves a view with no surface to the move-end recovery', () => {
  const { camera } = realCamera({ width: 1225, height: 923 });
  aim(camera, reportedStuckView);
  assert.equal(
    lookAngleWithinFrame(camera, 'lookUp', Cesium.Math.toRadians(5)),
    Cesium.Math.toRadians(5),
  );
});

// Surface only in the corners of a 16:9 frame, all of it outside the scope's
// keyhole: the full frame shows some planet, the scope shows none.
const cornerOnlyView = { alt: 18_000_000, pitch: -52, roll: 60 };

test('with a scope keyhole, surface hidden in the masked corners counts as none', () => {
  const { camera } = realCamera();
  aim(camera, cornerOnlyView);
  const keyhole = { keyholeRadius: KEYHOLE_OUTER_RADIUS };
  assert.ok(surfacePixelShare(camera, 1600, 900) > 0);
  assert.equal(surfacePixelShare(camera, 1600, 900, { keyhole: true }), 0);
  assert.equal(globeOutOfFrame(camera), false);
  assert.equal(globeOutOfFrame(camera, keyhole), true);
  aim(camera, { alt: 18_000_000, pitch: -90 });
  assert.ok(
    Math.abs(
      globeFrameShare(camera, keyhole) -
        surfacePixelShare(camera, 1600, 900, { keyhole: true }),
    ) < 0.03,
    'the keyhole share matches the pick-ray oracle',
  );
});

test('the recovery follows the scope: corner-only views are turned back only behind it', () => {
  for (const [scopeOn, expectRecovery] of [
    [true, true],
    [false, false],
  ]) {
    const { camera, viewer } = realCamera();
    installGlobeInViewRecovery(viewer, {
      keyholeRadius: () => (scopeOn ? KEYHOLE_OUTER_RADIUS : 0),
    });
    aim(camera, cornerOnlyView);
    camera.moveEnd.raiseEvent();
    assert.equal(
      Cesium.Math.equalsEpsilon(camera.pitch, -Math.PI / 2, 1e-6),
      expectRecovery,
      `scope ${scopeOn ? 'on' : 'off'}`,
    );
  }
});

test('the recovery leaves a camera flight and an authored scene alone', () => {
  let playing = true;
  const { camera, scene, viewer } = realCamera({ width: 1225, height: 923 });
  scene.camera = camera;
  scene.screenSpaceCameraController = { enableInputs: true };
  installGlobeInViewRecovery(viewer, { paused: () => playing });
  aim(camera, reportedStuckView);
  camera.moveEnd.raiseEvent();
  assert.equal(globeOutOfFrame(camera), true, 'a playing scene is left alone');
  playing = false;

  // A flight that pauses looking away is left alone until it ends.
  camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(10, 20, 18_000_000),
    duration: 5,
  });
  camera.moveEnd.raiseEvent();
  assert.equal(globeOutOfFrame(camera), true, 'a flight is left alone');
  camera.cancelFlight();
  camera.moveEnd.raiseEvent();
  assert.ok(Cesium.Math.equalsEpsilon(camera.pitch, -Math.PI / 2, 1e-6));
});

test('a check a scene or flight defers runs once it ends', () => {
  for (const viaMoveEnd of [false, true]) {
    let playing = true;
    const timers = fakeTimers();
    const { camera, viewer } = realCamera({ width: 1225, height: 923 });
    installGlobeInViewRecovery(viewer, {
      paused: () => playing,
      ...timers,
    });
    aim(camera, reportedStuckView);
    camera.moveStart.raiseEvent();
    // A hold on a stars-only shot: quiet, with or without Cesium's moveEnd.
    for (let i = 0; i < 4; i += 1) timers.tick();
    if (viaMoveEnd) camera.moveEnd.raiseEvent();
    // Longer than the settle check's five-minute bound.
    for (let i = 0; i < 1500; i += 1) timers.tick();
    assert.equal(globeOutOfFrame(camera), true, 'left alone while it plays');
    assert.equal(timers.pending(), 1, 'still watching');
    playing = false;
    timers.tick();
    assert.ok(
      Cesium.Math.equalsEpsilon(camera.pitch, -Math.PI / 2, 1e-6),
      `recovered once the scene ends (${viaMoveEnd ? 'after moveEnd' : 'no moveEnd'})`,
    );
  }
});

// Holding a drag still for half a second on a view that already showed no
// surface looked like a settled camera, and the view was turned down under
// the user's hand.
test('the recovery waits while a pointer is held on the globe', () => {
  const timers = fakeTimers();
  const { camera, scene, viewer } = realCamera({ width: 1225, height: 923 });
  const document = new EventTarget();
  scene.canvas = Object.assign(new EventTarget(), {
    clientWidth: 1225,
    clientHeight: 923,
    ownerDocument: document,
  });
  const dispose = installGlobeInViewRecovery(viewer, timers);
  aim(camera, reportedStuckView);
  scene.canvas.dispatchEvent(new Event('pointerdown'));
  camera.moveStart.raiseEvent();
  for (let i = 0; i < 8; i += 1) timers.tick();
  camera.moveEnd.raiseEvent();
  for (let i = 0; i < 8; i += 1) timers.tick();
  assert.equal(globeOutOfFrame(camera), true, 'left alone while held');
  document.dispatchEvent(new Event('pointerup'));
  for (let i = 0; i < 3; i += 1) timers.tick();
  assert.ok(
    Cesium.Math.equalsEpsilon(camera.pitch, -Math.PI / 2, 1e-6),
    'recovered once the pointer is released',
  );
  dispose();
  aim(camera, reportedStuckView);
  scene.canvas.dispatchEvent(new Event('pointerdown'));
  document.dispatchEvent(new Event('pointerup'));
  assert.equal(timers.pending(), 0, 'disposed recovery holds no listeners');
});

/** A held-pointer recovery over a canvas in a document in a window. */
function heldPointerRecovery() {
  const timers = fakeTimers();
  const { camera, scene, viewer } = realCamera({ width: 1225, height: 923 });
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    defaultView: window,
    visibilityState: 'visible',
  });
  scene.canvas = Object.assign(new EventTarget(), {
    clientWidth: 1225,
    clientHeight: 923,
    ownerDocument: document,
  });
  const dispose = installGlobeInViewRecovery(viewer, timers);
  const pointer = (target, type, pointerId, init = {}) =>
    target.dispatchEvent(
      Object.assign(new Event(type), { pointerId, ...init }),
    );
  /** Press, move and hold still: the check defers while a pointer is held. */
  const holdStill = () => {
    aim(camera, reportedStuckView);
    camera.moveStart.raiseEvent();
    for (let i = 0; i < 8; i += 1) timers.tick();
    camera.moveEnd.raiseEvent();
    for (let i = 0; i < 8; i += 1) timers.tick();
  };
  const settle = () => {
    for (let i = 0; i < 3; i += 1) timers.tick();
  };
  const recovered = () =>
    Cesium.Math.equalsEpsilon(camera.pitch, -Math.PI / 2, 1e-6);
  return {
    camera,
    document,
    window,
    dispose,
    pointer,
    holdStill,
    settle,
    recovered,
    canvas: scene.canvas,
  };
}

// Releasing one of two fingers cleared the held flag, and the recovery
// turned the view down under the finger still on the glass.
test('the recovery waits until every held pointer is released', () => {
  const h = heldPointerRecovery();
  h.pointer(h.canvas, 'pointerdown', 1);
  h.pointer(h.canvas, 'pointerdown', 2);
  h.holdStill();
  h.pointer(h.document, 'pointerup', 1);
  h.settle();
  assert.equal(h.recovered(), false, 'left alone under the second finger');
  assert.equal(globeOutOfFrame(h.camera), true);
  h.pointer(h.document, 'pointercancel', 2);
  h.settle();
  assert.equal(h.recovered(), true, 'recovered once both are released');
  h.dispose();
});

// A release the page never sees (the pointer let go outside the window)
// must not hold the recovery off for good.
for (const [label, lose] of [
  ['the window loses focus', (h) => h.window.dispatchEvent(new Event('blur'))],
  [
    'the page is hidden',
    (h) => {
      h.document.visibilityState = 'hidden';
      h.document.dispatchEvent(new Event('visibilitychange'));
    },
  ],
  [
    'the canvas loses the pointer capture',
    (h) => h.pointer(h.canvas, 'lostpointercapture', 1),
  ],
  [
    'the pointer moves with no button down',
    (h) => h.pointer(h.document, 'pointermove', 1, { buttons: 0 }),
  ],
]) {
  test(`a held pointer whose release is lost stops deferring when ${label}`, () => {
    const h = heldPointerRecovery();
    h.pointer(h.canvas, 'pointerdown', 1);
    h.holdStill();
    h.pointer(h.document, 'pointermove', 1, { buttons: 1 });
    h.settle();
    assert.equal(h.recovered(), false, 'left alone while held');
    lose(h);
    h.settle();
    assert.equal(h.recovered(), true, 'recovered once the hold is let go');
    h.dispose();
  });
}

function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (callback) => {
      const id = next++;
      pending.set(id, callback);
      return id;
    },
    clearTimeout: (id) => pending.delete(id),
    pending: () => pending.size,
    /** Run the earliest pending callback, as 250 ms passing would. */
    tick() {
      const [id, callback] = pending.entries().next().value ?? [];
      if (id === undefined) return false;
      pending.delete(id);
      callback();
      return true;
    },
  };
}

test('a stuck view is recovered once it has held still, without waiting for moveEnd', () => {
  // At this pose the camera can drift by a rounding error every frame, so
  // Cesium never sees it stop and never raises moveEnd for it.
  const timers = fakeTimers();
  const { camera, viewer } = realCamera({ width: 1225, height: 923 });
  installGlobeInViewRecovery(viewer, timers);
  aim(camera, reportedStuckView);
  camera.moveStart.raiseEvent();
  timers.tick();
  assert.equal(globeOutOfFrame(camera), true, 'one quiet sample is not enough');
  // A rounding-error drift between samples still counts as at rest.
  camera.lookUp(1e-15);
  timers.tick();
  assert.ok(Cesium.Math.equalsEpsilon(camera.pitch, -Math.PI / 2, 1e-6));
  // Under that drift Cesium raises no new moveStart, so a later move that
  // ends looking away is caught by the same check.
  aim(camera, reportedStuckView);
  timers.tick();
  timers.tick();
  assert.equal(globeOutOfFrame(camera), true, 'not yet at rest');
  timers.tick();
  assert.ok(Cesium.Math.equalsEpsilon(camera.pitch, -Math.PI / 2, 1e-6));
  camera.moveEnd.raiseEvent();
  assert.equal(timers.pending(), 0, 'moveEnd ends the check');
});

test('the settle check follows a long move and gives up five minutes after the last one', () => {
  // A drag of half a minute that stops at a stuck pose is still recovered.
  const long = fakeTimers();
  const dragged = realCamera({ width: 1225, height: 923 });
  installGlobeInViewRecovery(dragged.viewer, long);
  aim(dragged.camera, reportedStuckView);
  dragged.camera.moveStart.raiseEvent();
  for (let i = 0; i < 120; i += 1) {
    dragged.camera.moveLeft(0.01);
    long.tick();
  }
  assert.equal(globeOutOfFrame(dragged.camera), true, 'still moving');
  while (long.tick());
  assert.ok(
    Cesium.Math.equalsEpsilon(dragged.camera.pitch, -Math.PI / 2, 1e-6),
    'recovered once it stopped',
  );

  // A camera that keeps moving is followed, and left alone, for as long as it
  // moves; once it rests the check gives up five minutes later.
  const timers = fakeTimers();
  const { camera, viewer } = realCamera({ width: 1225, height: 923 });
  installGlobeInViewRecovery(viewer, timers);
  aim(camera, reportedStuckView);
  camera.moveStart.raiseEvent();
  for (let i = 0; i < 2000; i += 1) {
    camera.moveLeft(0.01);
    timers.tick();
  }
  assert.equal(timers.pending(), 1, 'still following after eight minutes');
  assert.equal(globeOutOfFrame(camera), true, 'a moving camera is left alone');
  let idleSamples = 0;
  while (timers.tick()) idleSamples += 1;
  assert.ok(
    Cesium.Math.equalsEpsilon(camera.pitch, -Math.PI / 2, 1e-6),
    'recovered once it stopped',
  );
  assert.ok(
    idleSamples >= 1200 && idleSamples <= 1205,
    `gave up ${idleSamples} samples after it stopped`,
  );

  const disposed = fakeTimers();
  const other = realCamera({ width: 1225, height: 923 });
  const dispose = installGlobeInViewRecovery(other.viewer, disposed);
  aim(other.camera, reportedStuckView);
  other.camera.moveStart.raiseEvent();
  dispose();
  assert.equal(disposed.pending(), 0, 'dispose cancels the pending check');
});
