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
  // The binding drives the needle from the scene's per-frame signal, not from
  // `camera.changed`, so the fixture has to carry one.
  scene.preRender = new Cesium.Event();
  camera.getPickRay = () => ({});
  return { viewer: { camera, scene }, target };
}

/** Place a real camera in an orbit around `target` and release the frame. */
function orbit(viewer, target, headingDeg, pitchRad, range) {
  viewer.camera.lookAt(
    target,
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(headingDeg),
      pitchRad,
      range,
    ),
  );
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
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

test('tilt alternates at globe range, not only at map range', () => {
  // The canonical full-globe view. The camera's own pitch here is tens of
  // degrees away from the orbit pitch, so a control reading the camera would
  // command oblique twice in a row and the map would never come back level.
  for (const range of [3_000, 250_000, 18_000_000]) {
    const { viewer } = createRealViewer(AUSTIN_GROUND);
    orbit(viewer, AUSTIN_GROUND, 0, STRAIGHT_DOWN_PITCH, range);

    const first = toggleCameraTilt(viewer);
    assert.deepEqual(
      first,
      { tilted: true, pitch: OBLIQUE_PITCH },
      `first click at ${range} m must tilt`,
    );
    const second = toggleCameraTilt(viewer);
    assert.deepEqual(
      second,
      { tilted: false, pitch: STRAIGHT_DOWN_PITCH },
      `second click at ${range} m must level (camera pitch reads ${Cesium.Math.toDegrees(viewer.camera.pitch).toFixed(1)} deg)`,
    );
    const third = toggleCameraTilt(viewer);
    assert.deepEqual(
      third,
      { tilted: true, pitch: OBLIQUE_PITCH },
      `third click at ${range} m must tilt again`,
    );
  }
});

test('the button shows the state the next click will produce, at every range', () => {
  for (const range of [3_000, 18_000_000]) {
    const { viewer } = createRealViewer(AUSTIN_GROUND);
    orbit(viewer, AUSTIN_GROUND, 0, STRAIGHT_DOWN_PITCH, range);
    const tiltButton = new FakeButton();
    const controls = bindCameraOrientationControls({
      viewer,
      elements: { tiltButton, northButton: new FakeButton() },
      runNavigation: (_noun, navigate) => navigate(),
    });

    assert.equal(
      tiltButton.getAttribute('aria-pressed'),
      'false',
      `straight down at ${range} m must not read as tilted`,
    );
    tiltButton.click();
    assert.equal(
      tiltButton.getAttribute('aria-pressed'),
      'true',
      `after one click at ${range} m the button must read tilted`,
    );
    // And the exact refresh that runs when the camera settles must agree.
    controls.refreshTilt();
    assert.equal(
      tiltButton.getAttribute('aria-pressed'),
      'true',
      `the settled state at ${range} m must agree with the commanded one`,
    );
    controls.destroy();
  }
});

test('the needle follows a rotation too small for the camera-changed threshold', () => {
  const { viewer } = createRealViewer(AUSTIN_GROUND);
  orbit(viewer, AUSTIN_GROUND, 0, Cesium.Math.toRadians(-80), 5_000);
  const northButton = new FakeButton();
  const controls = bindCameraOrientationControls({
    viewer,
    elements: { tiltButton: new FakeButton(), northButton },
    runNavigation: (_noun, navigate) => navigate(),
  });
  assert.equal(northButton.getAttribute('--camera-heading'), '0deg');

  // Ten degrees is far below Cesium's default percentageChanged, so
  // `camera.changed` may never fire for it; the per-frame signal must.
  let changedFired = 0;
  viewer.camera.changed.addEventListener(() => {
    changedFired += 1;
  });
  orbit(viewer, AUSTIN_GROUND, 10, Cesium.Math.toRadians(-80), 5_000);
  viewer.scene.preRender.raiseEvent();
  assert.equal(
    northButton.getAttribute('--camera-heading'),
    '10deg',
    `needle must follow a 10 degree rotation (camera.changed fired ${changedFired} time(s))`,
  );

  orbit(viewer, AUSTIN_GROUND, 13, Cesium.Math.toRadians(-80), 5_000);
  viewer.scene.preRender.raiseEvent();
  assert.equal(northButton.getAttribute('--camera-heading'), '13deg');
  controls.destroy();
});

test('a settled camera writes nothing, and teardown releases every signal', () => {
  const { viewer } = createRealViewer(AUSTIN_GROUND);
  orbit(viewer, AUSTIN_GROUND, 0, Cesium.Math.toRadians(-80), 5_000);
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

  const preRenderBefore = viewer.scene.preRender.numberOfListeners;
  const moveEndBefore = viewer.camera.moveEnd.numberOfListeners;
  const controls = bindCameraOrientationControls({
    viewer,
    elements: { tiltButton, northButton },
    runNavigation: (_noun, navigate) => navigate(),
  });
  assert.equal(viewer.scene.preRender.numberOfListeners, preRenderBefore + 1);
  assert.equal(viewer.camera.moveEnd.numberOfListeners, moveEndBefore + 1);

  writes = 0;
  for (let i = 0; i < 60; i += 1) viewer.scene.preRender.raiseEvent();
  assert.equal(writes, 0, '60 frames of a settled camera write nothing');

  orbit(viewer, AUSTIN_GROUND, 47, Cesium.Math.toRadians(-80), 5_000);
  viewer.scene.preRender.raiseEvent();
  assert.ok(writes > 0, 'a rotated camera updates the needle');
  writes = 0;
  for (let i = 0; i < 20; i += 1) viewer.scene.preRender.raiseEvent();
  assert.equal(writes, 0, 'and then goes quiet again');

  controls.destroy();
  assert.equal(viewer.scene.preRender.numberOfListeners, preRenderBefore);
  assert.equal(viewer.camera.moveEnd.numberOfListeners, moveEndBefore);
  writes = 0;
  orbit(viewer, AUSTIN_GROUND, 120, Cesium.Math.toRadians(-80), 5_000);
  viewer.scene.preRender.raiseEvent();
  viewer.camera.moveEnd.raiseEvent();
  tiltButton.click();
  assert.equal(writes, 0, 'a destroyed binding writes nothing');
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
  // The button shows the state the click just commanded, not a re-measurement.
  assert.equal(tiltButton.getAttribute('aria-pressed'), 'true');
  assert.equal(northButton.getAttribute('--camera-heading'), '90deg');

  viewer.camera.heading = -1e-12;
  controls.sync();
  assert.equal(northButton.getAttribute('--camera-heading'), '0deg');

  controls.destroy();
  tiltButton.click();
  assert.deepEqual(navigations, ['camera', 'camera']);
  assert.equal(STRAIGHT_DOWN_PITCH, Cesium.Math.toRadians(-89));
});
