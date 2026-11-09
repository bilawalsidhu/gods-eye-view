import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  readCameraTargetFrame,
  resetCameraNorth,
  toggleCameraTilt,
} from './cameraOrientationControls.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createCesiumEngine } from '../globe/cesium/createCesiumEngine.js';

// The aircraft and satellite displays pass native: handle to engine.camera.follow
// (src/layers/aircraft/render/display.js, src/layers/satellites/render/display.js).
const target = Cesium.Cartesian3.fromDegrees(-73.78, 40.64, 3000);
const aircraft = {
  gevTrackedId: 'flight:abc',
  gevDisplayPosition: () => target,
};
const followAircraft = (engine) =>
  engine.camera.follow({
    native: aircraft,
    position: () => target,
    viewFrom: { x: 1400, y: -1400, z: 1000 },
  });

// A Cesium viewer with a real camera and the tracked-entity surface the
// Cesium follow drives (no EntityView: the follow's own frame holds).
function cesiumViewer() {
  const scene = {
    canvas: { clientWidth: 1200, clientHeight: 800, width: 1200, height: 800 },
    drawingBufferWidth: 1200,
    drawingBufferHeight: 800,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84, pick: () => target },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    pickPositionSupported: false,
    requestRender() {},
    preRender: new Cesium.Event(),
    preUpdate: new Cesium.Event(),
    postRender: new Cesium.Event(),
    screenSpaceCameraController: { inertiaZoom: 0.8, minimumZoomDistance: 1 },
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  let tracked;
  const trackedEntityChanged = new Cesium.Event();
  const viewer = {
    scene,
    camera,
    canvas: scene.canvas,
    clock: { currentTime: Cesium.JulianDate.now(), onTick: new Cesium.Event() },
    entities: { add: (options) => new Cesium.Entity(options), remove() {} },
    isDestroyed: () => false,
    trackedEntityChanged,
    get trackedEntity() {
      return tracked;
    },
    set trackedEntity(entity) {
      if (entity === tracked) return;
      tracked = entity;
      trackedEntityChanged.raiseEvent(entity);
    },
  };
  viewer.engine = createCesiumEngine(viewer);
  return viewer;
}

for (const [name, act, check] of [
  ['north-up', resetCameraNorth, (frame) => frame.heading],
  ['tilt', toggleCameraTilt, (frame) => frame.pitch + Math.PI / 2],
]) {
  test(`${name} keeps an engine follow that carries a native handle (Navara aircraft)`, () => {
    const engine = createFakeEngine({ kind: 'navara' });
    const handle = followAircraft(engine);
    engine.fake.frame();
    assert.ok(act(engine), `${name} applied`);
    engine.fake.frame();
    assert.equal(engine.camera.following(), handle, `${name} keeps the follow`);
    handle.stop();
    engine.destroy();
  });

  test(`${name} keeps an engine follow on Cesium (aircraft)`, () => {
    const viewer = cesiumViewer();
    const { engine } = viewer;
    const handle = followAircraft(engine);
    viewer.scene.preUpdate.raiseEvent();
    assert.ok(act(engine, viewer), `${name} applied`);
    viewer.scene.preUpdate.raiseEvent();
    assert.equal(engine.camera.following(), handle, `${name} keeps the follow`);
    const frame = readCameraTargetFrame(engine, viewer);
    assert.ok(Math.abs(check(frame)) < 0.02, `${name} reached the camera`);
    handle.stop();
    engine.destroy();
  });
}
