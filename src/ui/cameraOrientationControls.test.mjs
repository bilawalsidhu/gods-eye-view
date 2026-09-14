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

test('center picking falls through an invalid depth hit to the ellipsoid', () => {
  const invalid = new Cesium.Cartesian3(Number.NaN, 0, 0);
  const { viewer, target } = createViewer({ pickPosition: () => invalid });
  assert.equal(pickViewTarget(viewer), target);
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
