import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  OBLIQUE_PITCH,
  STRAIGHT_DOWN_PITCH,
  bindCameraOrientationControls,
  pickViewTarget,
  readCameraTargetFrame,
  resetCameraNorth,
  toggleCameraTilt,
} from './cameraOrientationControls.js';

function createViewer({ cameraPosition, target, pickPosition = null } = {}) {
  const calls = [];
  const changed = new Cesium.Event();
  const surface = target || Cesium.Cartesian3.fromDegrees(0, 0, 0);
  const position = cameraPosition || Cesium.Cartesian3.fromDegrees(0, 0, 1_000);
  const camera = {
    positionWC: position,
    directionWC: new Cesium.Cartesian3(-1, 0, 0),
    upWC: new Cesium.Cartesian3(0, 0, 1),
    heading: Cesium.Math.toRadians(90),
    changed,
    pickEllipsoid: () => surface,
    getPickRay: () => ({}),
    lookAt(targetValue, offset) {
      calls.push({ type: 'lookAt', target: targetValue, offset });
    },
    lookAtTransform(transform) {
      calls.push({ type: 'lookAtTransform', transform });
    },
    setView(view) {
      calls.push({ type: 'setView', view });
    },
  };
  const viewer = {
    camera,
    scene: {
      canvas: { clientWidth: 1_200, clientHeight: 800 },
      pickPositionSupported: Boolean(pickPosition),
      pickPosition: pickPosition || (() => null),
      globe: { pick: () => surface },
      requestRender: () => calls.push({ type: 'requestRender' }),
    },
  };
  return { viewer, calls, target: surface };
}

class FakeButton extends EventTarget {
  constructor() {
    super();
    this.attributes = new Map();
    this.style = {
      setProperty: (name, value) => this.attributes.set(name, value),
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name);
  }
  click() {
    this.dispatchEvent(new Event('click'));
  }
}

/**
 * A real Cesium camera attached to a minimal offscreen scene.
 *
 * The fake above records what lookAt was asked for but never moves, so it
 * cannot show whether a frame written into the camera reads back as the same
 * frame. These cases need the production math on both sides.
 */
function createRealCamera() {
  const scene = {
    canvas: { clientWidth: 1200, clientHeight: 800, width: 1200, height: 800 },
    drawingBufferWidth: 1200,
    drawingBufferHeight: 800,
    mapProjection: new Cesium.GeographicProjection(Cesium.Ellipsoid.WGS84),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    // setView converts a world-space direction/up pair into the local frame
    // only in 3D, and the camera derives heading/pitch the same way, so the
    // scene mode is load-bearing here rather than decoration.
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  return { camera, scene };
}

/** A viewer whose center pick is a fixed ground point and whose camera is real. */
function createRealViewer(target) {
  const { camera, scene } = createRealCamera();
  scene.pickPositionSupported = false;
  scene.pickPosition = () => null;
  scene.globe.pick = () => target;
  scene.requestRender = () => {};
  camera.getPickRay = () => ({});
  return { viewer: { camera, scene }, target };
}

const AUSTIN_GROUND = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 0);

test('a heading written into a real camera reads back as the same heading', () => {
  // One oblique heading per quadrant, plus the cardinals, at pitches a user
  // reaches with the tilt control.
  for (const headingDeg of [0, 30, 90, 135, 180, 225, 270, 315, 350]) {
    for (const pitchDeg of [-25, -40, -65]) {
      const { viewer } = createRealViewer(AUSTIN_GROUND);
      viewer.camera.lookAt(
        AUSTIN_GROUND,
        new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(headingDeg),
          Cesium.Math.toRadians(pitchDeg),
          4000,
        ),
      );
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

      const frame = readCameraTargetFrame(viewer);
      assert.ok(frame, `no frame at ${headingDeg}/${pitchDeg}`);
      const readDeg = Cesium.Math.toDegrees(frame.heading);
      assert.ok(
        Math.abs(((readDeg - headingDeg + 540) % 360) - 180) < 0.01,
        `heading ${headingDeg} deg at pitch ${pitchDeg} read back as ${readDeg.toFixed(2)} deg`,
      );
      assert.ok(
        Math.abs(Cesium.Math.toDegrees(frame.pitch) - pitchDeg) < 0.01,
        `pitch ${pitchDeg} read back as ${Cesium.Math.toDegrees(frame.pitch).toFixed(2)}`,
      );
      assert.ok(Math.abs(frame.range - 4000) < 1, `range ${frame.range}`);
    }
  }
});

test('north-up really points a real camera north from every quadrant', () => {
  for (const headingDeg of [30, 135, 225, 315]) {
    const { viewer } = createRealViewer(AUSTIN_GROUND);
    viewer.camera.lookAt(
      AUSTIN_GROUND,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(headingDeg),
        Cesium.Math.toRadians(-40),
        4000,
      ),
    );
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

    assert.equal(
      resetCameraNorth(viewer),
      true,
      `reset failed at ${headingDeg}`,
    );
    const after = readCameraTargetFrame(viewer);
    assert.ok(after, `no frame after reset at ${headingDeg}`);
    const readDeg = Cesium.Math.toDegrees(after.heading);
    assert.ok(
      Math.min(readDeg, 360 - readDeg) < 0.01,
      `north-up from ${headingDeg} deg left the camera at ${readDeg.toFixed(2)} deg`,
    );
    assert.ok(
      Math.abs(Cesium.Math.toDegrees(after.pitch) + 40) < 0.01,
      'north-up must not change the pitch',
    );
    assert.ok(
      Math.abs(after.range - 4000) < 1,
      'north-up must not change the range',
    );
  }
});

test('tilt moves a real camera between the two pitches and keeps target and range', () => {
  const { viewer } = createRealViewer(AUSTIN_GROUND);
  viewer.camera.lookAt(
    AUSTIN_GROUND,
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(215),
      STRAIGHT_DOWN_PITCH,
      3000,
    ),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

  const first = toggleCameraTilt(viewer);
  assert.deepEqual(first, { tilted: true, pitch: OBLIQUE_PITCH });
  const tilted = readCameraTargetFrame(viewer);
  assert.ok(Math.abs(tilted.pitch - OBLIQUE_PITCH) < 1e-6);
  assert.ok(Math.abs(tilted.range - 3000) < 1, `range ${tilted.range}`);
  assert.ok(
    Math.abs(Cesium.Math.toDegrees(tilted.heading) - 215) < 0.01,
    'tilt must not rotate the map',
  );

  // Releasing the orbit frame must leave the camera pointing at the same
  // ground, not merely standing in the right place.
  const toTarget = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(
      AUSTIN_GROUND,
      viewer.camera.positionWC,
      new Cesium.Cartesian3(),
    ),
    new Cesium.Cartesian3(),
  );
  const offBy = Cesium.Math.toDegrees(
    Math.acos(
      Cesium.Math.clamp(
        Cesium.Cartesian3.dot(viewer.camera.directionWC, toTarget),
        -1,
        1,
      ),
    ),
  );
  assert.ok(
    offBy < 0.05,
    `camera points ${offBy.toFixed(2)} deg away from its target`,
  );

  const second = toggleCameraTilt(viewer);
  assert.deepEqual(second, { tilted: false, pitch: STRAIGHT_DOWN_PITCH });
  const down = readCameraTargetFrame(viewer);
  assert.ok(Math.abs(down.pitch - STRAIGHT_DOWN_PITCH) < 1e-6);
  assert.ok(Math.abs(down.range - 3000) < 1);
});

test('camera changes coalesce into one write per frame and go quiet when nothing moves', () => {
  const { viewer } = createRealViewer(AUSTIN_GROUND);
  viewer.camera.lookAt(
    AUSTIN_GROUND,
    new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-80), 5000),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

  const tiltButton = new FakeButton();
  const northButton = new FakeButton();
  let writes = 0;
  const count = (element) => {
    const setAttribute = element.setAttribute.bind(element);
    const setProperty = element.style.setProperty.bind(element.style);
    element.setAttribute = (name, value) => {
      writes += 1;
      setAttribute(name, value);
    };
    element.style.setProperty = (name, value) => {
      writes += 1;
      setProperty(name, value);
    };
  };
  count(tiltButton);
  count(northButton);

  const frames = [];
  const controls = bindCameraOrientationControls({
    viewer,
    elements: { tiltButton, northButton },
    runNavigation: (_noun, navigate) => navigate(),
    requestFrame: (callback) => frames.push(callback),
  });

  // A burst of camera-changed events must schedule exactly one frame of work.
  for (let i = 0; i < 40; i += 1) viewer.camera.changed.raiseEvent();
  assert.equal(
    frames.length,
    1,
    'a burst must coalesce into one scheduled write',
  );

  writes = 0;
  frames.splice(0).forEach((run) => run());
  assert.equal(writes, 0, 'an unmoved camera writes nothing');

  // A real rotation writes once, and repeating it writes nothing more.
  viewer.camera.lookAt(
    AUSTIN_GROUND,
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(90),
      Cesium.Math.toRadians(-80),
      5000,
    ),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  viewer.camera.changed.raiseEvent();
  frames.splice(0).forEach((run) => run());
  assert.ok(writes > 0, 'a rotated camera updates the compass');
  assert.equal(northButton.getAttribute('--camera-heading'), '90deg');

  writes = 0;
  for (let i = 0; i < 10; i += 1) viewer.camera.changed.raiseEvent();
  frames.splice(0).forEach((run) => run());
  assert.equal(writes, 0, 'a settled camera stops writing');

  controls.destroy();
  viewer.camera.changed.raiseEvent();
  assert.equal(frames.length, 0, 'a destroyed binding schedules nothing');
});

test('a sky-facing camera yields no frame and both actions decline', () => {
  const { camera, scene } = createRealCamera();
  scene.pickPositionSupported = false;
  scene.pickPosition = () => null;
  scene.globe.pick = () => undefined;
  scene.requestRender = () => {};
  camera.getPickRay = () => ({});
  camera.pickEllipsoid = () => undefined;
  const viewer = { camera, scene };

  assert.equal(readCameraTargetFrame(viewer), null);
  assert.equal(toggleCameraTilt(viewer), false);
  assert.equal(resetCameraNorth(viewer), false);
});

test('center picking prefers terrain over the ellipsoid and falls through an invalid depth hit', () => {
  const invalid = new Cesium.Cartesian3(Number.NaN, 0, 0);
  const terrain = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 400);
  const sea = Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 0);
  const { viewer } = createViewer({ pickPosition: () => invalid });
  viewer.scene.globe.pick = () => terrain;
  viewer.camera.pickEllipsoid = () => sea;
  assert.equal(
    pickViewTarget(viewer),
    terrain,
    'the rendered ground wins over sea level',
  );

  viewer.scene.globe.pick = () => null;
  assert.equal(
    pickViewTarget(viewer),
    sea,
    'the ellipsoid still answers when nothing is under the cursor',
  );
});

test('target frame identifies a straight-down camera in local ENU space', () => {
  const { viewer } = createViewer();
  const frame = readCameraTargetFrame(viewer);
  assert.ok(frame);
  assert.ok(Math.abs(frame.pitch - Cesium.Math.toRadians(-90)) < 0.001);
  assert.ok(frame.range > 999 && frame.range < 1_001);
  assert.equal(frame.heading, Cesium.Math.toRadians(90));
});

test('tilt preserves the picked target and range while choosing oblique pitch', () => {
  const { viewer, calls, target } = createViewer();
  const before = readCameraTargetFrame(viewer);
  const result = toggleCameraTilt(viewer);
  const lookAt = calls.find((call) => call.type === 'lookAt');
  assert.deepEqual(result, { tilted: true, pitch: OBLIQUE_PITCH });
  assert.equal(lookAt.target, target);
  assert.equal(lookAt.offset.range, before.range);
  assert.equal(lookAt.offset.pitch, OBLIQUE_PITCH);
  assert.ok(calls.some((call) => call.type === 'lookAtTransform'));
  assert.ok(calls.some((call) => call.type === 'setView'));
});

test('north-up preserves target pitch and range', () => {
  const { viewer, calls } = createViewer();
  const before = readCameraTargetFrame(viewer);
  assert.equal(resetCameraNorth(viewer), true);
  const lookAt = calls.find((call) => call.type === 'lookAt');
  assert.equal(lookAt.offset.heading, 0);
  assert.equal(lookAt.offset.pitch, before.pitch);
  assert.equal(lookAt.offset.range, before.range);
});

test('bindings route both controls and release every listener on destroy', () => {
  const { viewer } = createViewer();
  const tiltButton = new FakeButton();
  const northButton = new FakeButton();
  const navigations = [];
  const toasts = [];
  const controls = bindCameraOrientationControls({
    viewer,
    elements: { tiltButton, northButton },
    runNavigation(noun, navigate) {
      navigations.push(noun);
      return navigate();
    },
    showToast: (message) => toasts.push(message),
  });

  tiltButton.click();
  northButton.click();
  assert.deepEqual(navigations, ['camera', 'camera']);
  assert.deepEqual(toasts, ['Tilted view', 'North up']);
  assert.equal(tiltButton.getAttribute('aria-pressed'), 'false');
  assert.equal(northButton.getAttribute('--camera-heading'), '90deg');

  viewer.camera.heading = -1e-12;
  controls.sync();
  assert.equal(northButton.getAttribute('--camera-heading'), '0deg');

  controls.destroy();
  tiltButton.click();
  assert.deepEqual(navigations, ['camera', 'camera']);
  assert.equal(viewer.camera.changed.numberOfListeners, 0);
  assert.equal(STRAIGHT_DOWN_PITCH, Cesium.Math.toRadians(-89));
});
