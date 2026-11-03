import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  installZoomOutGuard,
  maxPitchForHeight,
  MAXIMUM_ZOOM_DISTANCE_M,
} from './zoomOutGuard.js';

const deg = Cesium.Math.toDegrees;
const { WHEEL, PINCH, RIGHT_DRAG, LEFT_DRAG, MIDDLE_DRAG } =
  Cesium.CameraEventType;
const { CTRL, SHIFT, ALT } = Cesium.KeyboardEventModifier;

test('maxPitchForHeight leaves low-altitude tilt alone', () => {
  assert.equal(maxPitchForHeight(0), null);
  assert.equal(maxPitchForHeight(299_999), null);
  assert.equal(maxPitchForHeight(NaN), null);
  assert.equal(maxPitchForHeight(undefined), null);
});

test('maxPitchForHeight looks 8 degrees below the limb', () => {
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
  const preRender = new Set();
  const postUpdate = new Set();
  const handoffs = new Set();
  const container = new EventTarget();
  const canvas = new EventTarget();
  const movements = new Map();
  const key = (type, modifier) => `${type}:${modifier}`;
  const aggregator = {
    resets: 0,
    destroys: 0,
    isMoving: (type, modifier) => movements.has(key(type, modifier)),
    getMovement: (type, modifier) => movements.get(key(type, modifier)),
    reset() {
      movements.clear();
      this.resets++;
    },
    destroy() {
      this.destroys++;
      movements.clear();
    },
  };
  const camera = {
    height: 170_000,
    longitude: 0,
    latitude: 0,
    heading: 0.4,
    pitch: Cesium.Math.toRadians(-25),
    roll: 0,
    transform: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    views: [],
    get positionCartographic() {
      return {
        height: this.height,
        longitude: this.longitude,
        latitude: this.latitude,
      };
    },
    get position() {
      return this.positionWC;
    },
    get positionWC() {
      return Cesium.Cartesian3.fromRadians(
        this.longitude,
        this.latitude,
        this.height,
      );
    },
    setView({ orientation }) {
      this.views.push(orientation);
      this.heading = orientation.heading;
      this.pitch = orientation.pitch;
      this.roll = orientation.roll;
    },
  };
  const controller = {
    maximumZoomDistance,
    enableInputs: true,
    enableZoom: true,
    zoomEventTypes: [
      RIGHT_DRAG,
      WHEEL,
      PINCH,
      { eventType: WHEEL, modifier: CTRL },
    ],
  };
  const scene = {
    mode: Cesium.SceneMode.SCENE3D,
    screenSpaceCameraController: controller,
    preRender: {
      addEventListener(handler) {
        preRender.add(handler);
        return () => preRender.delete(handler);
      },
    },
    postUpdate: {
      addEventListener(handler) {
        postUpdate.add(handler);
        return () => postUpdate.delete(handler);
      },
    },
  };
  const renders = [];
  const dispose = installZoomOutGuard(
    { camera, container, canvas, scene },
    {
      subscribeCameraHandoff(listener) {
        handoffs.add(listener);
        return () => handoffs.delete(listener);
      },
      createAggregator(element) {
        assert.equal(element, canvas);
        return aggregator;
      },
      requestRender: (reason) => renders.push(reason),
    },
  );
  // A frame Cesium skips drawing in request-render mode: no preRender.
  const idleFrame = () => {
    for (const handler of postUpdate) handler();
  };
  const frame = (height = camera.height) => {
    camera.height = height;
    idleFrame();
    for (const handler of preRender) handler();
  };
  const movement = (type, deltaY, { modifier, tiltDeltaY = 0 } = {}) => {
    const distance = {
      startPosition: new Cesium.Cartesian2(0, 0),
      endPosition: new Cesium.Cartesian2(0, deltaY),
    };
    movements.set(
      key(type, modifier),
      type === PINCH
        ? {
            distance,
            angleAndHeight: {
              startPosition: new Cesium.Cartesian2(0, 0),
              endPosition: new Cesium.Cartesian2(0, tiltDeltaY),
            },
          }
        : distance,
    );
    // Also exercise the former raw DOM path when running against the PR head.
    const event = new Event(
      type === WHEEL ? 'wheel' : type === PINCH ? 'touchmove' : 'pointermove',
    );
    Object.assign(event, {
      buttons: type === RIGHT_DRAG ? 2 : type === MIDDLE_DRAG ? 4 : 1,
      ctrlKey: modifier === CTRL,
      shiftKey: modifier === SHIFT,
      altKey: modifier === ALT,
      touches: type === PINCH ? [1, 2] : [],
    });
    container.dispatchEvent(event);
  };
  return {
    camera,
    controller,
    scene,
    aggregator,
    preRender,
    postUpdate,
    handoffs,
    handoff: () => {
      for (const listener of handoffs) listener();
    },
    renders,
    dispose,
    frame,
    idleFrame,
    movement,
  };
}

test('a tilted wheel zoom-out pitches down and preserves heading and roll', () => {
  const f = guardFixture();
  f.frame();
  f.movement(WHEEL, -10);
  f.frame(1_000_000);
  const target = maxPitchForHeight(1_000_000);
  assert.ok(f.camera.pitch < Cesium.Math.toRadians(-25));
  assert.ok(f.camera.pitch > target, 'eases rather than snapping');
  assert.equal(f.camera.heading, 0.4);
  assert.equal(f.camera.roll, 0);
  for (let i = 1; i <= 40; i++) f.frame(1_000_000 + i);
  assert.ok(
    Math.abs(f.camera.pitch - maxPitchForHeight(f.camera.height)) < 1e-3,
  );
  assert.ok(f.renders.length > 0);
});

test('a large outward step immediately keeps the Earth limb in view', () => {
  const f = guardFixture();
  f.frame(500_000);
  f.movement(WHEEL, -100);
  f.frame(20_000_000);
  const limbPitch = -Math.acos(6_371_000 / (6_371_000 + 20_000_000));
  assert.ok(f.camera.pitch <= limbPitch);
  assert.ok(f.camera.pitch > maxPitchForHeight(20_000_000));
});

test('pinch, right-drag and configured Ctrl+wheel can zoom out', () => {
  for (const [type, modifier] of [[PINCH], [RIGHT_DRAG], [WHEEL, CTRL]]) {
    const f = guardFixture();
    f.frame(500_000);
    f.movement(type, -10, { modifier });
    f.frame(700_000);
    assert.equal(f.camera.views.length, 1, `${type}:${modifier}`);
    f.dispose();
  }
});

test('Ctrl+right-drag tilt is left at the pose chosen by Cesium', () => {
  const f = guardFixture();
  f.frame(500_000);
  f.movement(RIGHT_DRAG, 3, { modifier: CTRL });
  // Real Cesium's orbit tilt raises altitude with no zoom movement.
  f.camera.pitch = Cesium.Math.toRadians(-26.07722459498313);
  f.frame(529_392.3759876974);
  assert.equal(f.camera.views.length, 0);
  assert.equal(deg(f.camera.pitch), -26.07722459498313);
});

test('parallel two-finger tilt is not mistaken for pinch zoom', () => {
  const f = guardFixture();
  f.frame(500_000);
  f.movement(PINCH, 0, { tiltDeltaY: 3 });
  f.frame(600_000);
  assert.equal(f.camera.views.length, 0);
});

test('two-finger tilt with finger-spacing drift is left to Cesium', () => {
  for (const [spacing, tilt] of [
    [-0.01, 3],
    [-2, 3],
    [-3, -3],
  ]) {
    const f = guardFixture();
    f.frame(500_000);
    f.movement(PINCH, spacing, { tiltDeltaY: tilt });
    // Real Cesium's two-finger tilt climbs and picks its own pitch.
    f.camera.pitch = Cesium.Math.toRadians(-26.07746);
    f.frame(529_406);
    assert.equal(f.camera.views.length, 0, `${spacing}, ${tilt}`);
    f.dispose();
  }
});

test('a pinch that closes the fingers more than it moves them still zooms out', () => {
  // One finger still, the other sliding towards it: the midpoint moves half as far.
  const f = guardFixture();
  f.frame(500_000);
  f.movement(PINCH, -10, { tiltDeltaY: -5 });
  f.frame(700_000);
  assert.equal(f.camera.views.length, 1);
  f.dispose();
});

test('unconfigured wheel modifiers and one-finger drag do not enable the guard', () => {
  for (const [type, modifier] of [[WHEEL, SHIFT], [WHEEL, ALT], [LEFT_DRAG]]) {
    const f = guardFixture();
    f.frame(500_000);
    f.movement(type, -10, { modifier });
    f.frame(600_000);
    assert.equal(f.camera.views.length, 0, `${type}:${modifier}`);
    f.dispose();
  }
});

test('current controller zoom bindings are honored', () => {
  const f = guardFixture();
  f.frame(500_000);
  f.controller.zoomEventTypes = { eventType: MIDDLE_DRAG, modifier: ALT };
  f.movement(WHEEL, -10);
  f.frame(600_000);
  assert.equal(f.camera.views.length, 0);
  f.movement(MIDDLE_DRAG, -10, { modifier: ALT });
  f.frame(700_000);
  assert.equal(f.camera.views.length, 1);
});

test('programmatic height changes alone never activate the guard', () => {
  const f = guardFixture();
  f.frame(170_000);
  f.frame(2_000_000);
  f.frame(3_000_000);
  assert.equal(f.camera.views.length, 0);
});

test('inward zoom does not activate the guard even when altitude rises', () => {
  const f = guardFixture();
  f.frame(500_000);
  f.movement(WHEEL, 10);
  f.frame(600_000);
  assert.equal(f.camera.views.length, 0);
});

test('outward input with falling height does not alter pitch', () => {
  const f = guardFixture();
  f.frame(2_000_000);
  f.movement(WHEEL, -10);
  f.frame(1_500_000);
  f.frame(1_500_000);
  assert.equal(f.camera.views.length, 0);
});

test('pitch finishes settling when the zoom stops changing height', () => {
  const f = guardFixture();
  f.frame(500_000);
  f.movement(WHEEL, -10);
  f.frame(2_000_000);
  const firstPitch = f.camera.pitch;
  for (let i = 0; i < 40; i++) f.frame();
  assert.ok(f.camera.pitch < firstPitch);
  assert.ok(Math.abs(f.camera.pitch - maxPitchForHeight(2_000_000)) < 1e-10);
  const views = f.camera.views.length;
  f.frame();
  assert.equal(
    f.camera.views.length,
    views,
    'settled pose does not keep rendering',
  );
});

test('completed settling does not authorize a later programmatic climb', () => {
  const f = guardFixture();
  f.frame(500_000);
  f.movement(WHEEL, -10);
  f.frame(700_000);
  for (let i = 0; i < 40; i++) f.frame();
  const views = f.camera.views.length;
  f.frame(3_000_000);
  assert.equal(f.camera.views.length, views);
});

test('a fresh inward zoom or unrelated gesture cancels pending correction', () => {
  for (const [type, delta, options] of [
    [WHEEL, 10, {}],
    [RIGHT_DRAG, 3, { modifier: CTRL }],
    [LEFT_DRAG, 3, {}],
    [MIDDLE_DRAG, 3, {}],
    [PINCH, 0, { tiltDeltaY: 3 }],
  ]) {
    const f = guardFixture();
    f.frame(500_000);
    f.movement(WHEEL, -10);
    f.frame(700_000);
    const views = f.camera.views.length;
    f.movement(type, delta, options);
    f.frame(800_000);
    f.frame(900_000);
    assert.equal(f.camera.views.length, views, `${type}:${options.modifier}`);
    f.dispose();
  }
});

test('an external pose change at fixed height cancels pending correction', () => {
  for (const field of ['heading', 'pitch', 'roll', 'longitude', 'latitude']) {
    const f = guardFixture();
    f.frame(500_000);
    f.movement(WHEEL, -10);
    f.frame(700_000);
    const views = f.camera.views.length;
    f.camera[field] += 0.1;
    f.frame();
    f.frame(900_000);
    assert.equal(f.camera.views.length, views, field);
    f.dispose();
  }
});

test('disabled controls, flights, tracked transforms and non-3D scenes cancel intent', () => {
  const cases = [
    (f) => {
      f.controller.enableInputs = false;
      return () => {
        f.controller.enableInputs = true;
      };
    },
    (f) => {
      f.controller.enableZoom = false;
      return () => {
        f.controller.enableZoom = true;
      };
    },
    (f) => {
      f.camera._currentFlight = {};
      return () => {
        delete f.camera._currentFlight;
      };
    },
    (f) => {
      f.camera.transform = Cesium.Matrix4.fromTranslation(
        new Cesium.Cartesian3(1, 2, 3),
      );
      return () => {
        f.camera.transform = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
      };
    },
    (f) => {
      f.scene.mode = Cesium.SceneMode.SCENE2D;
      return () => {
        f.scene.mode = Cesium.SceneMode.SCENE3D;
      };
    },
  ];
  for (const block of cases) {
    const f = guardFixture();
    f.frame(500_000);
    f.movement(WHEEL, -10);
    f.frame(700_000);
    const views = f.camera.views.length;
    const restore = block(f);
    f.movement(WHEEL, -10);
    f.frame(800_000);
    restore();
    f.frame(900_000);
    assert.equal(f.camera.views.length, views);
    f.movement(WHEEL, -10);
    f.frame(1_000_000);
    assert.equal(f.camera.views.length, views + 1);
    f.dispose();
  }
});

test('installer sets the ceiling and disposer releases aggregator and frame listener', () => {
  const f = guardFixture();
  assert.equal(f.controller.maximumZoomDistance, MAXIMUM_ZOOM_DISTANCE_M);
  assert.equal(f.preRender.size, 1);
  assert.equal(f.postUpdate.size, 1);
  f.frame();
  assert.ok(f.aggregator.resets > 0);
  f.dispose();
  f.dispose();
  assert.equal(f.controller.maximumZoomDistance, Infinity);
  assert.equal(f.aggregator.destroys, 1);
  assert.equal(f.preRender.size, 0);
  assert.equal(f.postUpdate.size, 0);
  assert.equal(f.handoffs.size, 0);
});

test('installer preserves a stricter host zoom ceiling', () => {
  const f = guardFixture({ maximumZoomDistance: 123 });
  assert.equal(f.controller.maximumZoomDistance, 123);
  f.dispose();
  assert.equal(f.controller.maximumZoomDistance, 123);
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

test('outward input at the ceiling reframes a deliberately tilted camera', () => {
  const f = guardFixture();
  f.frame(MAXIMUM_ZOOM_DISTANCE_M);
  f.movement(WHEEL, -10);
  f.frame();
  for (let i = 0; i < 40; i++) f.frame();
  assert.ok(
    Math.abs(f.camera.pitch - maxPitchForHeight(MAXIMUM_ZOOM_DISTANCE_M)) <
      1e-10,
  );
  f.dispose();
});

test('input that leaves the camera still requests a frame to read it', () => {
  const f = guardFixture();
  f.frame(MAXIMUM_ZOOM_DISTANCE_M);
  f.idleFrame();
  assert.deepEqual(f.renders, [], 'an idle scene stays idle');
  // At the ceiling Cesium doesn't move the camera, so nothing would draw.
  f.movement(WHEEL, -10);
  f.idleFrame();
  assert.deepEqual(f.renders, ['zoom-out-guard']);
  f.frame();
  assert.ok(f.camera.pitch < Cesium.Math.toRadians(-25), 'read that frame');
  f.dispose();
});

test('equivalent heading and roll wraps do not cancel stationary settling', () => {
  const f = guardFixture();
  f.frame(500_000);
  f.movement(WHEEL, -10);
  f.frame(2_000_000);
  f.camera.heading += Cesium.Math.TWO_PI;
  f.camera.roll += Cesium.Math.TWO_PI;
  for (let i = 0; i < 40; i++) f.frame();
  assert.ok(Math.abs(f.camera.pitch - maxPitchForHeight(2_000_000)) < 1e-10);
  f.dispose();
});

test('a real Cesium camera settles across the north heading wrap at Istanbul', () => {
  const scene = {
    canvas: { clientWidth: 1200, clientHeight: 800, width: 1200, height: 800 },
    drawingBufferWidth: 1200,
    drawingBufferHeight: 800,
    mapProjection: new Cesium.GeographicProjection(),
    globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    preRender: new Cesium.Event(),
    postUpdate: new Cesium.Event(),
    screenSpaceCameraController: {
      maximumZoomDistance: Infinity,
      enableInputs: true,
      zoomEventTypes: [WHEEL],
    },
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  const setHeight = (height) =>
    camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(28.9784, 41.0082, height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-25), roll: 0 },
    });
  setHeight(1_000_000);
  let outward = false;
  const dispose = installZoomOutGuard(
    { scene, camera, canvas: scene.canvas },
    {
      createAggregator: () => ({
        isMoving: (type, modifier) =>
          outward && type === WHEEL && modifier === undefined,
        getMovement: () => ({
          startPosition: { y: 0 },
          endPosition: { y: -10 },
        }),
        reset: () => {
          outward = false;
        },
        destroy() {},
      }),
      requestRender() {},
    },
  );
  try {
    setHeight(MAXIMUM_ZOOM_DISTANCE_M);
    outward = true;
    for (let i = 0; i < 40; i++) scene.preRender.raiseEvent(scene);
    assert.ok(
      Math.abs(
        camera.pitch - maxPitchForHeight(camera.positionCartographic.height),
      ) < 1e-8,
    );
  } finally {
    dispose();
  }
});

test('an outward inertia ceiling adjustment can descend while pitch settles', () => {
  const f = guardFixture();
  f.frame(39_000_000);
  f.movement(WHEEL, -10);
  f.frame(39_999_999);
  const before = f.camera.pitch;
  // Cesium limits slant range on an inertial pick, slightly below the altitude cap.
  f.frame(39_997_258);
  for (let i = 0; i < 40; i++) f.frame();
  assert.ok(f.camera.pitch < before);
  assert.ok(
    Math.abs(f.camera.pitch - maxPitchForHeight(f.camera.height)) < 1e-10,
  );
  f.dispose();
});

test('a descending programmatic tilt cancels pending correction', () => {
  const f = guardFixture();
  f.frame(39_000_000);
  f.movement(WHEEL, -10);
  f.frame(39_999_999);
  const count = f.camera.views.length;
  f.camera.pitch += 0.1;
  f.frame(39_997_258);
  for (let i = 0; i < 40; i++) f.frame();
  assert.equal(f.camera.views.length, count);
  f.dispose();
});

test('explicit navigation cancels outward inertia before a climbing UI tilt', () => {
  const f = guardFixture();
  f.movement(WHEEL, -10);
  f.frame(1_000_000);
  f.movement(WHEEL, -10);
  f.handoff();
  const writes = f.camera.views.length;
  f.camera.pitch = Cesium.Math.toRadians(-25);
  f.frame(1_100_000);
  f.frame(1_200_000);
  assert.equal(f.camera.views.length, writes);
  assert.equal(deg(f.camera.pitch), -25);
  // A subsequent user zoom starts a new correction normally.
  f.movement(WHEEL, -10);
  f.frame(1_300_000);
  assert.ok(f.camera.views.length > writes);
  f.dispose();
});

// A real Cesium camera and controller, fed by DOM wheel events on the canvas.
function realControllerScene(startHeight) {
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: 1200,
    clientHeight: 800,
    width: 1200,
    height: 800,
    style: {},
    // Keep Cesium's input handler off the missing `document`.
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
    mapProjection: new Cesium.GeographicProjection(),
    ellipsoid: Cesium.Ellipsoid.WGS84,
    mapMode2D: Cesium.MapMode2D.INFINITE_SCROLL,
    mode: Cesium.SceneMode.SCENE3D,
    pixelRatio: 1,
    verticalExaggeration: 1,
    verticalExaggerationRelativeHeight: 0,
    preRender: new Cesium.Event(),
    postUpdate: new Cesium.Event(),
  };
  const camera = new Cesium.Camera(scene);
  scene.camera = camera;
  const controller = new Cesium.ScreenSpaceCameraController(scene);
  controller.inertiaZoom = 0;
  scene.screenSpaceCameraController = controller;
  const setHeight = (h) =>
    camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(28.9784, 41.0082, h),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
    });
  setHeight(startHeight);
  const dispose = installZoomOutGuard(
    { scene, camera, canvas },
    { requestRender() {} },
  );
  // Scene.render order: the controller applies input, then postUpdate, then
  // preRender on frames that draw.
  const frame = () => {
    controller.update();
    scene.postUpdate.raiseEvent(scene);
    scene.preRender.raiseEvent(scene);
  };
  const wheel = (deltaY) =>
    canvas.dispatchEvent(
      Object.assign(new Event('wheel'), {
        deltaY,
        deltaMode: 0,
        clientX: 600,
        clientY: 400,
      }),
    );
  const height = () => camera.positionCartographic.height;
  return {
    scene,
    camera,
    controller,
    setHeight,
    frame,
    wheel,
    height,
    dispose,
  };
}

test('a camera placed above the ceiling cannot zoom out and zooms in without a jump', () => {
  const s = realControllerScene(60_000_000);
  try {
    s.frame();
    s.wheel(1);
    s.frame();
    assert.ok(Math.abs(s.height() - 60_000_000) < 1, `${s.height()} m`);
    s.wheel(-1);
    s.frame();
    const firstStep = s.height();
    assert.ok(firstStep < 60_000_000, 'zooms in');
    assert.ok(firstStep > 50_000_000, `${firstStep} m is gradual`);
    // The camera can no longer climb back above where it has descended to.
    s.wheel(1);
    s.frame();
    assert.ok(Math.abs(s.height() - firstStep) < 1, `${s.height()} m`);
    for (let i = 0; i < 40; i++) {
      s.wheel(-100);
      s.frame();
    }
    assert.ok(s.height() < MAXIMUM_ZOOM_DISTANCE_M);
    assert.equal(s.controller.maximumZoomDistance, MAXIMUM_ZOOM_DISTANCE_M);
    for (let i = 0; i < 80; i++) {
      s.wheel(100);
      s.frame();
    }
    assert.ok(Math.abs(s.height() - MAXIMUM_ZOOM_DISTANCE_M) < 1_000);
  } finally {
    s.dispose();
  }
  assert.equal(s.controller.maximumZoomDistance, Infinity);
});

test('a share-link view restored above the ceiling is honoured by later frames', () => {
  const s = realControllerScene(1_000_000);
  try {
    s.frame();
    s.setHeight(97_679_259);
    s.frame();
    s.wheel(100);
    s.frame();
    assert.ok(Math.abs(s.height() - 97_679_259) < 1, `${s.height()} m`);
  } finally {
    s.dispose();
  }
});

test('a tracked camera cannot climb past the ceiling from its target', () => {
  const s = realControllerScene(1_000_000);
  try {
    s.frame();
    // In look-at mode Cesium measures zoom from the target, not the Earth.
    s.camera.lookAt(
      Cesium.Cartesian3.fromDegrees(0, 0, 35_786_000),
      new Cesium.HeadingPitchRange(0, -0.5, 5_000_000),
    );
    for (let i = 0; i < 20; i++) {
      s.wheel(100);
      s.frame();
    }
    const range = Cesium.Cartesian3.magnitude(s.camera.position);
    assert.ok(range <= MAXIMUM_ZOOM_DISTANCE_M + 1_000, `${range} m`);
    assert.equal(s.controller.maximumZoomDistance, MAXIMUM_ZOOM_DISTANCE_M);
  } finally {
    s.dispose();
  }
});
