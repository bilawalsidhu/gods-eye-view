import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createControlledCamera } from './controlledCamera.js';
import { createCesiumRendererPlugin } from './appRenderer.js';

/** A Cesium camera as the native camera reads and writes it. */
function fakeCamera({ aspectRatio = 2 } = {}) {
  const camera = {
    position: new Cesium.Cartesian3(1, 2, 3),
    direction: new Cesium.Cartesian3(0, 0, -1),
    up: new Cesium.Cartesian3(0, 1, 0),
    right: new Cesium.Cartesian3(1, 0, 0),
    transform: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
    frustum: { fov: 1, aspectRatio, near: 0.5, far: 1e9 },
    lookAtTransform(matrix) {
      camera.transform = Cesium.Matrix4.clone(matrix);
    },
    get positionWC() {
      return camera.position;
    },
    get directionWC() {
      return camera.direction;
    },
    get upWC() {
      return camera.up;
    },
  };
  return camera;
}

/** A controller factory recording what it is given and asked. */
function fakeController(log) {
  let given;
  const factory = (options) => {
    given = options;
    return {
      port: {
        followFrame: () => new Float64Array(16),
        controls: {
          suspend: (reason) => {
            log.push(`suspend ${reason}`);
            return () => log.push(`release ${reason}`);
          },
        },
      },
      frame: {
        beforeUpdate: (tick) => log.push(['before', tick]),
        afterUpdate: (tick) => log.push(['after', tick]),
      },
      destroy: () => log.push('destroy'),
    };
  };
  return { factory, given: () => given };
}

function make(log, overrides = {}) {
  const camera = fakeCamera();
  const own = { enableInputs: true, enableCollisionDetection: true };
  const scene = {
    camera,
    canvas: { clientWidth: 800, clientHeight: 400 },
    screenSpaceCameraController: own,
    isDestroyed: () => false,
  };
  const controller = fakeController(log);
  const part = createControlledCamera({
    scene,
    controller: controller.factory,
    query: {},
    requestRender: (reason) => log.push(`render ${reason}`),
    report: () => {},
    thresholds: true,
    followFrame: true,
    keyTarget: null,
    ...overrides,
  });
  return { part, camera, own, native: controller.given().native, controller };
}

test('the native camera reads Cesium’s camera and writes the eye exactly', () => {
  const { native, camera } = make([]);
  assert.deepEqual(native.pose(), {
    position: { x: 1, y: 2, z: 3 },
    direction: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
    near: 0.5,
    far: 1e9,
  });
  assert.deepEqual(native.viewport(), { width: 800, height: 400 });
  // Out of a lookAt frame first.
  camera.transform = Cesium.Matrix4.fromTranslation(
    new Cesium.Cartesian3(5, 5, 5),
  );
  const fovy = Math.PI / 3;
  native.setPose({
    position: { x: 7e6, y: 0, z: 0 },
    direction: { x: -1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    right: { x: 0, y: -1, z: 0 },
    fovy,
  });
  assert.ok(Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY));
  assert.deepEqual(
    [camera.position, camera.direction, camera.up, camera.right].map((v) => [
      v.x,
      v.y,
      v.z,
    ]),
    [
      [7e6, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, -1, 0],
    ],
  );
  // A wide canvas: Cesium's fov spans its width, so the vertical one is kept.
  const vertical =
    2 *
    Math.atan(Math.tan(camera.frustum.fov / 2) / camera.frustum.aspectRatio);
  assert.ok(Math.abs(vertical - fovy) < 1e-12);
});

test('Cesium’s rounding of the eye written is still that eye; a real move is read as it stands', () => {
  const { native, camera } = make([]);
  const eye = {
    position: { x: 7e6, y: 1, z: 2 },
    direction: { x: -1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    right: { x: 0, y: -1, z: 0 },
    fovy: 1,
  };
  native.setPose(eye);
  // Cesium derives its world vectors again: a component off by 2e-16.
  camera.direction = new Cesium.Cartesian3(-1, 2.2e-16, 0);
  camera.position = new Cesium.Cartesian3(7e6 + 1e-9, 1, 2);
  const pose = native.pose();
  assert.deepEqual(pose.direction, eye.direction);
  assert.deepEqual(pose.position, eye.position);
  // Moved for real (by something other than the controller): read as it is.
  camera.position = new Cesium.Cartesian3(7e6 + 1, 1, 2);
  assert.equal(native.pose().position.x, 7e6 + 1);
  // And the written eye is let go: back within rounding of it, still as it is.
  camera.position = new Cesium.Cartesian3(7e6 + 1e-9, 1, 2);
  assert.equal(native.pose().position.x, 7e6 + 1e-9);
});

test('a tall canvas takes the vertical field of view as Cesium’s fov', () => {
  const { native, camera } = make([]);
  camera.frustum.aspectRatio = 0.5;
  native.setPose({ ...native.pose(), right: { x: 1, y: 0, z: 0 }, fovy: 0.8 });
  assert.equal(camera.frustum.fov, 0.8);
});

test('Cesium’s own controls stay off while the controller drives the camera', () => {
  const log = [];
  const { part, own } = make(log);
  assert.equal(own.enableInputs, false);
  assert.equal(own.enableCollisionDetection, false, 'its collision off too');
  // Cesium's own flight ending writes it back on: still off.
  own.enableInputs = true;
  assert.equal(own.enableInputs, false);
  part.dispose();
  part.dispose();
  assert.equal(own.enableInputs, true, 'given back');
  assert.equal(own.enableCollisionDetection, true);
  assert.deepEqual(log, ['destroy'], 'the controller destroyed once');
});

test('the frame steps go to the controller, and stop once disposed', () => {
  const log = [];
  const { part } = make(log);
  part.before({ now: 1, time: 2 });
  part.after({ now: 1, time: 2 });
  part.dispose();
  part.before({ now: 3, time: 4 });
  assert.deepEqual(log, [
    ['before', { now: 1, time: 2 }],
    ['after', { now: 1, time: 2 }],
    'destroy',
  ]);
});

test('pointer listeners taken before the input port is made hear it once attached', () => {
  const log = [];
  const { part, controller } = make(log);
  const relay = controller.given().input;
  const heard = [];
  relay.on('down', (e) => heard.push(['down', e]));
  const off = relay.on('wheel', (e) => heard.push(['wheel', e]));
  off();
  const handlers = new Map();
  part.attachInput({
    on(type, cb) {
      handlers.set(type, cb);
      return () => handlers.delete(type);
    },
  });
  assert.deepEqual([...handlers.keys()], ['down'], 'only what is still wanted');
  handlers.get('down')(1);
  relay.on('up', (e) => heard.push(['up', e]));
  handlers.get('up')(2);
  assert.deepEqual(heard, [
    ['down', 1],
    ['up', 2],
  ]);
});

test('camera holds are the controller’s, and the follow frame only where it is a capability', () => {
  const log = [];
  const { part } = make(log);
  const release = part.suspendCamera('lease');
  release();
  assert.deepEqual(log, ['suspend lease', 'release lease']);
  assert.equal(typeof part.port.followFrame, 'function');
  const without = make([], { followFrame: false });
  assert.equal(without.part.port.followFrame, undefined);
});

test('the query port’s picks and heights are the native camera’s', () => {
  const picks = [];
  const { native } = make([], {
    query: {
      pickPosition: (x, y) => (picks.push([x, y]), { x, y, z: 0 }),
      sampleHeightNow: () => 12,
    },
  });
  assert.deepEqual(native.pickPosition(3, 4), { x: 3, y: 4, z: 0 });
  assert.equal(native.sampleHeightNow({ lon: 0, lat: 0 }), 12);
  assert.equal(make([]).native.pickPosition, undefined, 'none without one');
});

test('a drawn item’s position is the draw port’s, where it has one', () => {
  const asked = [];
  const { native } = make([], {
    itemPosition: (item, aheadMs) => (
      asked.push([item, aheadMs]),
      { x: 1, y: 2, z: 3 }
    ),
  });
  assert.deepEqual(native.itemPosition({ set: 's', id: 'm' }, 250), {
    x: 1,
    y: 2,
    z: 3,
  });
  assert.deepEqual(asked, [[{ set: 's', id: 'm' }, 250]]);
  assert.equal(make([]).native.itemPosition, undefined, 'none without one');
});

/** A Cesium event of its own, raised in the order listeners were added. */
function event() {
  const listeners = [];
  return {
    listeners,
    addEventListener(cb) {
      listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
    raise(...args) {
      for (const cb of [...listeners]) cb(...args);
    },
  };
}

test('the application’s Cesium renderer runs the controller around its preUpdate listeners', async (t) => {
  const saved = globalThis.document;
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    body: { appendChild() {} },
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  t.after(() => {
    globalThis.document = saved;
  });
  const order = [];
  const scene = {
    camera: fakeCamera(),
    canvas: {
      clientWidth: 800,
      clientHeight: 400,
      addEventListener() {},
      removeEventListener() {},
    },
    primitives: { add() {}, remove() {} },
    screenSpaceCameraController: { enableInputs: true },
    requestRender() {},
    preUpdate: event(),
    postUpdate: event(),
    preRender: event(),
    postRender: event(),
    isDestroyed: () => false,
  };
  const viewer = {
    scene,
    camera: scene.camera,
    canvas: scene.canvas,
    clock: { currentTime: Cesium.JulianDate.fromDate(new Date(1000)) },
    entities: { contains: () => false },
    isDestroyed: () => false,
    destroy() {},
  };
  const holds = [];
  const plugin = createCesiumRendererPlugin({
    createViewer: () => viewer,
    cameraController: ({ native }) => ({
      port: {
        native,
        controls: {
          suspend: (reason) => (holds.push(reason), () => {}),
        },
      },
      frame: {
        beforeUpdate: (tick) => order.push(['before', tick.time]),
        afterUpdate: () => order.push('after'),
      },
      destroy: () => order.push('destroy'),
    }),
  });
  const renderer = await plugin.create({ container: {} });
  assert.equal(scene.screenSpaceCameraController.enableInputs, false);
  assert.equal(typeof renderer.camera.native.setPose, 'function');
  renderer.frame.on('preUpdate', () => order.push('preUpdate'));
  scene.preUpdate.raise(scene, Cesium.JulianDate.fromDate(new Date(5000)));
  assert.deepEqual(order, [['before', 5000], 'preUpdate', 'after']);
  // A lease's hold is the controller's.
  renderer.input.lease?.('test', { camera: true })?.release?.();
  renderer.destroy();
  assert.equal(order.at(-1), 'destroy');
  assert.equal(scene.screenSpaceCameraController.enableInputs, true);
});

test('what the controller throws in a frame step is reported, not thrown into Cesium’s loop', () => {
  const reported = [];
  const camera = fakeCamera();
  const part = createControlledCamera({
    scene: {
      camera,
      canvas: { clientWidth: 800, clientHeight: 400 },
      screenSpaceCameraController: { enableInputs: true },
      isDestroyed: () => false,
    },
    controller: () => ({
      port: { controls: { suspend: () => () => {} } },
      frame: {
        beforeUpdate: () => {
          throw new Error('before');
        },
        afterUpdate: () => {
          throw new Error('after');
        },
      },
      destroy() {},
    }),
    query: {},
    requestRender() {},
    report: (error) => reported.push(error.message),
    thresholds: true,
    followFrame: true,
    keyTarget: null,
  });
  part.before({ now: 0, time: 0 });
  part.after({ now: 0, time: 0 });
  assert.deepEqual(reported, ['before', 'after']);
  part.dispose();
});

test('a canvas resized keeps the vertical field of view last written', () => {
  const { part, native, camera } = make([]);
  native.setPose({ ...native.pose(), right: { x: 1, y: 0, z: 0 }, fovy: 0.8 });
  camera.frustum.aspectRatio = 3;
  part.before({ now: 1, time: 1 });
  const vertical =
    2 *
    Math.atan(Math.tan(camera.frustum.fov / 2) / camera.frustum.aspectRatio);
  assert.ok(Math.abs(vertical - 0.8) < 1e-12);
  camera.frustum.aspectRatio = 0.5;
  part.before({ now: 2, time: 2 });
  assert.equal(camera.frustum.fov, 0.8);
});
