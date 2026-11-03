import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  installZoomOutGuard,
  maxPitchForHeight,
  MAXIMUM_ZOOM_DISTANCE_M,
  USER_ZOOM_WINDOW_MS,
} from './zoomOutGuard.js';

const deg = Cesium.Math.toDegrees;

test('maxPitchForHeight leaves low-altitude tilt alone', () => {
  assert.equal(maxPitchForHeight(0), null);
  assert.equal(maxPitchForHeight(299_999), null);
  assert.equal(maxPitchForHeight(NaN), null);
  assert.equal(maxPitchForHeight(undefined), null);
});

test('maxPitchForHeight looks 8 degrees below the limb', () => {
  // Limb at 1,000 km is 30.2 degrees below the horizontal.
  assert.ok(Math.abs(deg(maxPitchForHeight(1_000_000)) + 38.19) < 0.01);
  assert.equal(deg(maxPitchForHeight(1e12)), -90);
});

test('maxPitchForHeight steepens monotonically with height', () => {
  let previous = 0;
  for (let h = 300_000; h <= 100_000_000; h *= 1.5) {
    const pitch = maxPitchForHeight(h);
    assert.ok(pitch <= previous, `pitch at ${h} m`);
    previous = pitch;
  }
});

function guardFixture({ maximumZoomDistance = Infinity } = {}) {
  let clock = 0;
  const listeners = new Map();
  const preRender = new Set();
  const container = {
    addEventListener(type, handler, options) {
      assert.equal(options.capture, true);
      listeners.set(type, handler);
    },
    removeEventListener(type, handler, capture) {
      assert.equal(capture, true);
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    emit(event) {
      listeners.get(event.type)?.(event);
    },
  };
  const camera = {
    height: 170_000,
    heading: 0.4,
    pitch: Cesium.Math.toRadians(-25),
    roll: 0,
    transform: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    views: [],
    get positionCartographic() {
      return { height: this.height };
    },
    setView({ orientation }) {
      this.views.push(orientation);
      this.heading = orientation.heading;
      this.pitch = orientation.pitch;
      this.roll = orientation.roll;
    },
  };
  const controller = { maximumZoomDistance, enableInputs: true };
  const viewer = {
    camera,
    container,
    scene: {
      screenSpaceCameraController: controller,
      preRender: {
        addEventListener(handler) {
          preRender.add(handler);
          return () => preRender.delete(handler);
        },
      },
    },
  };
  const renders = [];
  const dispose = installZoomOutGuard(viewer, {
    now: () => clock,
    requestRender: (reason) => renders.push(reason),
  });
  const frame = (height) => {
    camera.height = height;
    for (const handler of preRender) handler();
  };
  return {
    camera,
    controller,
    container,
    listeners,
    preRender,
    renders,
    dispose,
    frame,
    advance: (ms) => (clock += ms),
  };
}

test('a tilted wheel zoom-out pitches down to keep the globe framed', () => {
  const f = guardFixture();
  f.frame(170_000);
  f.container.emit({ type: 'wheel' });
  f.frame(1_000_000);
  const target = maxPitchForHeight(1_000_000);
  assert.ok(f.camera.pitch < Cesium.Math.toRadians(-25));
  assert.ok(f.camera.pitch > target, 'eases rather than snapping');
  assert.equal(f.camera.heading, 0.4);
  for (let i = 1; i <= 40; i++) f.frame(1_000_000 + i);
  assert.ok(
    Math.abs(f.camera.pitch - maxPitchForHeight(f.camera.height)) < 1e-3,
  );
  assert.ok(f.renders.length > 0);
});

test('two-finger touch and right-drag count as zoom input, one finger does not', () => {
  const f = guardFixture();
  f.frame(500_000);
  f.container.emit({ type: 'touchmove', touches: [1] });
  f.container.emit({ type: 'pointermove', buttons: 1 });
  f.frame(600_000);
  assert.equal(f.camera.views.length, 0);
  f.container.emit({ type: 'touchmove', touches: [1, 2] });
  f.frame(700_000);
  assert.equal(f.camera.views.length, 1);
  f.container.emit({ type: 'pointermove', buttons: 2 });
  f.frame(800_000);
  assert.equal(f.camera.views.length, 2);
});

test('guard leaves the camera alone without recent user zoom input', () => {
  const f = guardFixture();
  f.frame(170_000);
  f.frame(2_000_000); // programmatic flight, no input
  f.container.emit({ type: 'wheel' });
  f.advance(USER_ZOOM_WINDOW_MS + 1);
  f.frame(3_000_000);
  assert.equal(f.camera.views.length, 0);
});

test('guard only acts while zooming out', () => {
  const f = guardFixture();
  f.frame(2_000_000);
  f.container.emit({ type: 'wheel' });
  f.frame(1_500_000);
  f.frame(1_500_000);
  assert.equal(f.camera.views.length, 0);
});

test('guard yields to disabled inputs, tracked transforms and flights', () => {
  const f = guardFixture();
  f.frame(500_000);
  f.container.emit({ type: 'wheel' });

  f.controller.enableInputs = false;
  f.frame(600_000);
  f.controller.enableInputs = true;

  f.camera.transform = Cesium.Matrix4.fromTranslation(
    new Cesium.Cartesian3(1, 2, 3),
  );
  f.frame(700_000);
  f.camera.transform = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);

  f.camera._currentFlight = {};
  f.frame(800_000);
  delete f.camera._currentFlight;
  assert.equal(f.camera.views.length, 0);

  f.frame(900_000);
  assert.equal(f.camera.views.length, 1);
});

test('installer sets the zoom ceiling and the disposer restores it', () => {
  const f = guardFixture({ maximumZoomDistance: 123 });
  assert.equal(f.controller.maximumZoomDistance, MAXIMUM_ZOOM_DISTANCE_M);
  assert.equal(f.listeners.size, 3);
  assert.equal(f.preRender.size, 1);
  f.dispose();
  f.dispose();
  assert.equal(f.controller.maximumZoomDistance, 123);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.preRender.size, 0);
});

test('disposer keeps a ceiling someone else changed later', () => {
  const f = guardFixture();
  f.controller.maximumZoomDistance = 5;
  f.dispose();
  assert.equal(f.controller.maximumZoomDistance, 5);
});

test('installer rejects an incomplete viewer', () => {
  assert.throws(() => installZoomOutGuard({}), TypeError);
});
