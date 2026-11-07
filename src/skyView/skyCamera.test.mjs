import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createObserver } from './observer.js';
import {
  applySkyCamera,
  applySkyScene,
  applySkyTime,
  collisionRestoreLifts,
  readCameraAzEl,
  restoreCamera,
  restoreScene,
  snapshotCamera,
  skyTilesShown,
  snapshotScene,
  worldDirectionToAzEl,
} from './skyCamera.js';
import { EL_MAX_DEG, EL_MIN_DEG, makeView, normalizeAz } from './skyMath.js';

const DEG = Math.PI / 180;
const HOUSTON = createObserver({
  latDeg: 29.7604,
  lonDeg: -95.3698,
  groundHeightM: 15,
  heightKnown: true,
});

function fakeViewer({ width = 1200, height = 800 } = {}) {
  const scene = {
    canvas: { clientWidth: width, clientHeight: height, width, height },
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: {
      ellipsoid: Cesium.Ellipsoid.WGS84,
      show: true,
      enableLighting: false,
      dynamicAtmosphereLighting: true,
      dynamicAtmosphereLightingFromSun: false,
    },
    ellipsoid: Cesium.Ellipsoid.WGS84,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    requestRender: () => {},
    preRender: new Cesium.Event(),
    skyBox: { show: true },
    skyAtmosphere: { show: true },
    screenSpaceCameraController: {
      enableInputs: true,
      enableCollisionDetection: true,
    },
    primitives: { length: 0, get: () => undefined },
  };
  const camera = new Cesium.Camera(scene);
  camera.frustum.aspectRatio = width / height;
  scene.camera = camera;
  const clock = new Cesium.Clock({
    currentTime: Cesium.JulianDate.fromIso8601('2026-10-11T12:00:00Z'),
    shouldAnimate: false,
    multiplier: 1,
  });
  return { scene, camera, clock };
}

const azDiff = (a, b) => {
  const d = Math.abs(normalizeAz(a) - normalizeAz(b));
  return d > 180 ? 360 - d : d;
};

test('az/el -> Cesium setView -> camera heading/pitch AND world direction round trip within 0.01 deg on a 1-degree grid', () => {
  const { camera } = fakeViewer();
  let worstEl = 0;
  let worstAz = 0;
  let checked = 0;
  for (let az = 0; az < 360; az += 1) {
    for (let el = EL_MIN_DEG; el <= EL_MAX_DEG; el += 1) {
      applySkyCamera(
        Cesium,
        camera,
        HOUSTON,
        makeView({ azDeg: az, elDeg: el, fovDeg: 60 }),
      );
      const read = readCameraAzEl(camera);
      const world = worldDirectionToAzEl(
        Cesium,
        camera.positionWC,
        camera.directionWC,
      );
      worstEl = Math.max(
        worstEl,
        Math.abs(read.elDeg - el),
        Math.abs(world.elDeg - el),
      );
      // The world look direction must match everywhere below the zenith.
      // Cesium's camera.heading GETTER reports heading + 180 within ~2 deg of
      // the zenith (it switches to the up vector there; measured: el 88, 89),
      // so the getter is only compared below that band.
      if (el < 90) worstAz = Math.max(worstAz, azDiff(world.azDeg, az));
      if (el < 88) worstAz = Math.max(worstAz, azDiff(read.azDeg, az));
      checked += 1;
    }
  }
  assert.equal(checked, 360 * 101);
  assert.ok(worstEl < 0.01, `worst el error ${worstEl}`);
  assert.ok(worstAz < 0.01, `worst az error ${worstAz}`);
});

test('applySkyCamera puts the eye at ground + 1.7 m and sets the fov', () => {
  const { camera } = fakeViewer();
  applySkyCamera(
    Cesium,
    camera,
    HOUSTON,
    makeView({ azDeg: 10, elDeg: 30, fovDeg: 45 }),
  );
  const carto = camera.positionCartographic;
  assert.ok(Math.abs(carto.height - 16.7) < 1e-6, String(carto.height));
  assert.ok(Math.abs(carto.latitude / DEG - 29.7604) < 1e-9);
  assert.ok(Math.abs(carto.longitude / DEG + 95.3698) < 1e-9);
  assert.ok(Math.abs(camera.frustum.fov - 45 * DEG) < 1e-12);
});

function poseDelta(camera, before) {
  const diffs = ['position', 'direction', 'up', 'right'].map((key) =>
    Cesium.Cartesian3.distance(camera[key], before[key]),
  );
  return Math.max(...diffs);
}

test('exit restore: camera position/orientation/frustum back to 1e-6 (orbit view)', () => {
  const { camera } = fakeViewer();
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 2500),
    orientation: { heading: 0.7, pitch: -0.6, roll: 0.01 },
  });
  camera.frustum.fov = 1.05;
  const before = snapshotCamera(Cesium, camera);
  const heading = camera.heading;
  const pitch = camera.pitch;
  const roll = camera.roll;
  applySkyCamera(
    Cesium,
    camera,
    HOUSTON,
    makeView({ azDeg: 200, elDeg: 70, fovDeg: 20 }),
  );
  assert.ok(poseDelta(camera, before) > 1);
  restoreCamera(Cesium, camera, before);
  assert.ok(
    poseDelta(camera, before) < 1e-6,
    `pose delta ${poseDelta(camera, before)}`,
  );
  assert.ok(Math.abs(camera.heading - heading) < 1e-6);
  assert.ok(Math.abs(camera.pitch - pitch) < 1e-6);
  assert.ok(Math.abs(camera.roll - roll) < 1e-6);
  assert.ok(Math.abs(camera.frustum.fov - 1.05) < 1e-12);
});

test('exit restore also restores a non-identity camera transform (lookAt frame)', () => {
  const { camera } = fakeViewer();
  const target = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 0);
  camera.lookAt(target, new Cesium.HeadingPitchRange(0.3, -0.5, 1500));
  const before = snapshotCamera(Cesium, camera);
  const worldBefore = Cesium.Cartesian3.clone(camera.positionWC);
  applySkyCamera(Cesium, camera, HOUSTON, makeView({ azDeg: 0, elDeg: 45 }));
  assert.ok(Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY));
  restoreCamera(Cesium, camera, before);
  assert.ok(
    Cesium.Matrix4.equalsEpsilon(camera.transform, before.transform, 1e-9),
  );
  assert.ok(Cesium.Cartesian3.distance(camera.positionWC, worldBefore) < 1e-6);
});

test('scene snapshot/apply/restore: inputs disabled in sky, every flag back on exit', () => {
  const viewer = fakeViewer();
  const tileset = Object.create(Cesium.Cesium3DTileset.prototype);
  Object.defineProperty(tileset, 'show', { value: true, writable: true });
  tileset.isDestroyed = () => false;
  viewer.scene.primitives = { length: 1, get: () => tileset };
  const before = {
    globe: viewer.scene.globe.show,
    lighting: viewer.scene.globe.enableLighting,
    fromSun: viewer.scene.globe.dynamicAtmosphereLightingFromSun,
    skyBox: viewer.scene.skyBox.show,
    inputs: viewer.scene.screenSpaceCameraController.enableInputs,
    time: Cesium.JulianDate.clone(viewer.clock.currentTime),
  };
  const snap = snapshotScene(Cesium, viewer, { nowMs: 0 });
  applySkyScene(viewer, snap, { flatHorizon: true, skyBox: false });
  assert.equal(viewer.scene.screenSpaceCameraController.enableInputs, false);
  assert.equal(
    viewer.scene.screenSpaceCameraController.enableCollisionDetection,
    false,
  );
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(tileset.show, false);
  assert.equal(viewer.scene.globe.enableLighting, true);
  assert.equal(viewer.scene.globe.dynamicAtmosphereLightingFromSun, true);
  assert.equal(viewer.scene.skyBox.show, false);
  applySkyScene(viewer, snap, { flatHorizon: false, skyBox: true });
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(tileset.show, true);
  assert.equal(viewer.scene.skyBox.show, true);
  applySkyTime(Cesium, viewer, Date.parse('2026-10-12T03:30:00Z'));
  assert.equal(
    Cesium.JulianDate.toIso8601(viewer.clock.currentTime, 0),
    '2026-10-12T03:30:00Z',
  );
  restoreScene(Cesium, viewer, snap, { nowMs: 60_000 });
  assert.equal(viewer.scene.globe.show, before.globe);
  assert.equal(viewer.scene.globe.enableLighting, before.lighting);
  assert.equal(
    viewer.scene.globe.dynamicAtmosphereLightingFromSun,
    before.fromSun,
  );
  assert.equal(viewer.scene.skyBox.show, before.skyBox);
  assert.equal(
    viewer.scene.screenSpaceCameraController.enableInputs,
    before.inputs,
  );
  assert.equal(
    viewer.scene.screenSpaceCameraController.enableCollisionDetection,
    true,
  );
  assert.equal(tileset.show, true);
  // stopped clock: exact instant back
  assert.ok(Cesium.JulianDate.equals(viewer.clock.currentTime, before.time));
});

test('a running clock resumes where it would be now (no jump back in time)', () => {
  const viewer = fakeViewer();
  viewer.clock.shouldAnimate = true;
  viewer.clock.multiplier = 2;
  const t0 = Cesium.JulianDate.clone(viewer.clock.currentTime);
  const snap = snapshotScene(Cesium, viewer, { nowMs: 1_000 });
  applySkyTime(Cesium, viewer, Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(viewer.clock.shouldAnimate, false);
  restoreScene(Cesium, viewer, snap, { nowMs: 11_000 });
  assert.equal(viewer.clock.shouldAnimate, true);
  assert.equal(viewer.clock.multiplier, 2);
  const elapsed = Cesium.JulianDate.secondsDifference(
    viewer.clock.currentTime,
    t0,
  );
  assert.ok(Math.abs(elapsed - 20) < 1e-6, String(elapsed));
});

test('skyTilesShown: tiles on screen with a real horizon, none with the flat horizon; unknown = shown (attribution)', () => {
  const live = { isDestroyed: () => false };
  const gone = { isDestroyed: () => true };
  const snap = (globeShow, tilesets = []) => ({ globeShow, tilesets });
  assert.equal(skyTilesShown(snap(true)), true, 'globe drawn');
  assert.equal(
    skyTilesShown(snap(true), { flatHorizon: true }),
    false,
    'flat horizon hides the globe and every tileset',
  );
  assert.equal(
    skyTilesShown(snap(false, [{ primitive: live, show: true }])),
    true,
    'Google 3D tiles with the globe off',
  );
  assert.equal(
    skyTilesShown(snap(false, [{ primitive: live, show: true }]), {
      flatHorizon: true,
    }),
    false,
  );
  assert.equal(
    skyTilesShown(snap(false, [{ primitive: live, show: false }])),
    false,
    'globe off, tileset hidden: only the sky',
  );
  assert.equal(
    skyTilesShown(snap(false, [{ primitive: gone, show: true }])),
    false,
    'a destroyed tileset draws nothing',
  );
  assert.equal(skyTilesShown(snap(false)), false);
  assert.equal(skyTilesShown(snap(undefined)), true, 'unknown globe flag');
  assert.equal(skyTilesShown(null), true, 'no snapshot: cannot tell');
});

function realControllerViewer() {
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 1200,
    clientHeight: 800,
    width: 1200,
    height: 800,
    style: {},
    disableRootEvents: true,
    onwheel: null,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 1200,
      height: 800,
    }),
  });
  const scene = {
    canvas,
    drawingBufferWidth: 1200,
    drawingBufferHeight: 800,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: {
      ellipsoid: Cesium.Ellipsoid.WGS84,
      show: true,
      enableLighting: false,
    },
    ellipsoid: Cesium.Ellipsoid.WGS84,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    verticalExaggeration: 1,
    verticalExaggerationRelativeHeight: 0,
    globeHeight: 138,
    requestRender() {},
    preRender: new Cesium.Event(),
    skyBox: { show: true },
    skyAtmosphere: { show: true },
    primitives: { length: 0, get: () => undefined },
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  const controller = new Cesium.ScreenSpaceCameraController(scene);
  scene.screenSpaceCameraController = controller;
  return {
    scene,
    camera,
    clock: new Cesium.Clock({
      currentTime: Cesium.JulianDate.fromIso8601('2026-10-11T12:00:00Z'),
      shouldAnimate: false,
    }),
  };
}

function placeAt(viewer, height) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-95.3698, 29.7604, height),
    orientation: { heading: 0, pitch: -0.2, roll: 0 },
  });
  return Cesium.Cartesian3.clone(viewer.camera.positionWC);
}

function movedM(viewer, before) {
  return Cesium.Cartesian3.distance(before, viewer.camera.positionWC);
}

test('real controller lifts only under globeHeight plus minimumZoomDistance', () => {
  const viewer = realControllerViewer();
  const controller = viewer.scene.screenSpaceCameraController;
  const scene = viewer.scene;
  controller.enableCollisionDetection = true;
  controller.minimumZoomDistance = 20;
  scene.globeHeight = 138;
  controller._lastGlobeHeight = 138;
  const floor = scene.globeHeight + controller.minimumZoomDistance;

  const below = placeAt(viewer, floor - 5);
  controller.update();
  assert.ok(
    movedM(viewer, below) > 1,
    'a settled surface lifts a camera under the floor',
  );

  const aboveTerrain = placeAt(viewer, 500);
  assert.ok(500 < controller.minimumCollisionTerrainHeight);
  controller.update();
  assert.ok(
    movedM(viewer, aboveTerrain) < 1,
    '500 m over a 138 m surface is not a collision, even under 15 km',
  );

  scene.globeHeight = undefined;
  controller._lastGlobeHeight = 0;
  const unknown = placeAt(viewer, 16.7);
  for (let frame = 0; frame < 30; frame += 1) controller.update();
  assert.ok(
    movedM(viewer, unknown) < 1,
    'an unknown globeHeight does not lift on this update',
  );

  scene.globeHeight = 138;
  controller._lastGlobeHeight = 0;
  const cold = placeAt(viewer, 16.7);
  let liftedAt = -1;
  for (let frame = 0; frame < 40; frame += 1) {
    controller.update();
    if (movedM(viewer, cold) > 1) {
      liftedAt = frame;
      break;
    }
  }
  assert.ok(
    liftedAt > 0,
    'an unsettled surface still lifts once _lastGlobeHeight converges',
  );

  controller.enableCollisionDetection = false;
  scene.globeHeight = 138;
  controller._lastGlobeHeight = 138;
  const off = placeAt(viewer, 16.7);
  for (let frame = 0; frame < 5; frame += 1) controller.update();
  assert.ok(movedM(viewer, off) < 1, 'collision off never lifts');
  controller.destroy();
});

test('collisionRestoreLifts uses globeHeight plus minimum distance, and unknown is not safe', () => {
  const viewer = realControllerViewer();
  const controller = viewer.scene.screenSpaceCameraController;
  controller.minimumZoomDistance = 20;
  viewer.scene.globeHeight = 138;
  const floor = 138 + controller.minimumZoomDistance;

  placeAt(viewer, floor - 5);
  assert.equal(collisionRestoreLifts(viewer.camera, controller, true), true);
  placeAt(viewer, 500);
  assert.equal(
    collisionRestoreLifts(viewer.camera, controller, true),
    false,
    'above the terrain floor is safe even under 15 km',
  );
  viewer.scene.globeHeight = 0;
  placeAt(viewer, 50);
  assert.ok(50 > viewer.scene.globeHeight + controller.minimumZoomDistance);
  assert.equal(
    collisionRestoreLifts(viewer.camera, controller, true),
    false,
    'a known ellipsoid height of 0 is not an unknown surface',
  );
  viewer.scene.globeHeight = undefined;
  placeAt(viewer, 500);
  assert.equal(
    collisionRestoreLifts(viewer.camera, controller, true),
    true,
    'an unknown surface must defer, not look safe',
  );
  placeAt(viewer, controller.minimumCollisionTerrainHeight + 10);
  assert.equal(
    collisionRestoreLifts(viewer.camera, controller, true),
    false,
    'above the controller ceiling never lifts, even if the surface is unknown',
  );
  placeAt(viewer, 16.7);
  assert.equal(collisionRestoreLifts(viewer.camera, controller, false), false);
  controller.destroy();
});

test('restoreScene writes the saved collision flag; deferCollision is the handoff opt-out', () => {
  const viewer = realControllerViewer();
  const controller = viewer.scene.screenSpaceCameraController;
  controller.enableCollisionDetection = true;
  const snap = snapshotScene(Cesium, viewer);
  controller.enableCollisionDetection = false;
  placeAt(viewer, 16.7);
  controller._lastGlobeHeight = 138;
  restoreScene(Cesium, viewer, snap);
  assert.equal(
    controller.enableCollisionDetection,
    true,
    'a normal restore puts collision back even under the floor',
  );

  controller.enableCollisionDetection = false;
  restoreScene(Cesium, viewer, snap, { deferCollision: true });
  assert.equal(
    controller.enableCollisionDetection,
    false,
    'handoff may ask restoreScene to leave collision off',
  );
  const parked = Cesium.Cartesian3.clone(viewer.camera.positionWC);
  for (let frame = 0; frame < 30; frame += 1) controller.update();
  assert.ok(movedM(viewer, parked) < 1, `deferred restore lifted ${movedM(viewer, parked)} m`);
  controller.destroy();

  const low = realControllerViewer();
  const lowController = low.scene.screenSpaceCameraController;
  lowController.enableCollisionDetection = false;
  const lowSnap = snapshotScene(Cesium, low);
  lowController.enableCollisionDetection = true;
  placeAt(low, 16.7);
  lowController._lastGlobeHeight = 138;
  restoreScene(Cesium, low, lowSnap);
  assert.equal(
    lowController.enableCollisionDetection,
    false,
    'a saved off flag is written even at eye height',
  );
  lowController.destroy();
});
