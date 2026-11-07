import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { acquireCameraInput } from './cameraInput.js';
import {
  coastToInertia,
  controllerDefaults,
  createCesiumControls,
  inertiaToCoast,
} from './cameraControls.js';
import { holdFollowZoom } from './follow.js';

const { WHEEL, PINCH, RIGHT_DRAG, LEFT_DRAG } = Cesium.CameraEventType;
const { CTRL, SHIFT } = Cesium.KeyboardEventModifier;

/** A controller with Cesium's defaults. */
const sceneWithController = () => ({
  screenSpaceCameraController: { ...controllerDefaults(), enableInputs: true },
});

test('settings read and write the controller', () => {
  const scene = sceneWithController();
  const c = scene.screenSpaceCameraController;
  const { controls, dispose } = createCesiumControls({ scene });
  assert.equal(controls.enableTilt, true);
  controls.enableTilt = false;
  controls.enableRotate = false;
  controls.enableZoom = false;
  assert.deepEqual(
    [c.enableTilt, c.enableRotate, c.enableZoom],
    [false, false, false],
  );
  assert.equal(controls.minDistance, 1);
  assert.equal(controls.maxDistance, Infinity);
  controls.minDistance = 20;
  controls.maxDistance = 4e7;
  assert.deepEqual([c.minimumZoomDistance, c.maximumZoomDistance], [20, 4e7]);
  assert.equal(controls.zoomFactor, 5);
  controls.zoomFactor = 15;
  assert.equal(c.zoomFactor, 15);
  dispose();
});

test('coast is Cesium inertia as decay seconds', () => {
  const scene = sceneWithController();
  const c = scene.screenSpaceCameraController;
  const { controls } = createCesiumControls({ scene });
  assert.ok(Math.abs(controls.coast.drag - 0.4) < 1e-9, 'spin 0.9 is 0.4 s');
  assert.ok(Math.abs(controls.coast.zoom - 0.2) < 1e-9, 'zoom 0.8 is 0.2 s');
  assert.ok(Object.isFrozen(controls.coast));
  controls.coast = { drag: 0.25, zoom: 0 };
  assert.ok(Math.abs(c.inertiaSpin - 0.84) < 1e-12);
  assert.equal(c.inertiaTranslate, c.inertiaSpin);
  assert.equal(c.inertiaZoom, 1, 'a coast of 0 is no inertia');
  assert.equal(controls.coast.zoom, 0);
  assert.throws(() => (controls.coast = { drag: -1, zoom: 0 }), TypeError);
  assert.throws(() => (controls.coast = { drag: 1 }), TypeError);
  for (const s of [0.01, 0.2, 0.4, 3])
    assert.ok(Math.abs(inertiaToCoast(coastToInertia(s)) - s) < 1e-12);
});

test('a follow’s zoom hold composes with the zoom settings', () => {
  const scene = sceneWithController();
  const c = scene.screenSpaceCameraController;
  const { controls } = createCesiumControls({ scene });
  const owner = {};
  const release = holdFollowZoom(c, owner, 150);
  assert.equal(c.minimumZoomDistance, 150);
  assert.equal(controls.minDistance, 1, 'reads the controller’s own floor');
  assert.ok(Math.abs(controls.coast.zoom - 0.2) < 1e-9);
  controls.minDistance = 500;
  assert.equal(c.minimumZoomDistance, 500, 'a higher floor applies at once');
  controls.minDistance = 30;
  assert.equal(c.minimumZoomDistance, 150, 'the follow’s floor still holds');
  controls.coast = { drag: 0.4, zoom: 0.5 };
  assert.equal(c.inertiaZoom, 0, 'zoom coasting stays off while following');
  controls.coast = { drag: 0.4, zoom: 0 };
  assert.equal(c.inertiaZoom, 1, 'a coast of 0 is not lengthened by a follow');
  controls.coast = { drag: 0.4, zoom: 0.5 };
  release();
  assert.equal(c.minimumZoomDistance, 30, 'the follow gives back the new one');
  assert.ok(Math.abs(controls.coast.zoom - 0.5) < 1e-9);
});

test('collision is the controller’s collision switch', () => {
  const scene = sceneWithController();
  const c = scene.screenSpaceCameraController;
  const { controls } = createCesiumControls({ scene });
  assert.equal(controls.collision, 'both');
  controls.collision = 'none';
  assert.equal(c.enableCollisionDetection, false);
  assert.equal(controls.collision, 'none');
  controls.collision = 'terrain';
  assert.equal(c.enableCollisionDetection, true);
  assert.equal(controls.collision, 'terrain');
  c.enableCollisionDetection = false;
  assert.equal(controls.collision, 'none', 'follows a direct write');
  assert.throws(() => (controls.collision = 'water'), TypeError);
});

test('pitchRange keeps its upper end as the tilt limit', () => {
  const scene = sceneWithController();
  const c = scene.screenSpaceCameraController;
  const { controls } = createCesiumControls({ scene });
  assert.deepEqual(controls.pitchRange, [-Math.PI / 2, Math.PI / 2]);
  controls.pitchRange = [-1.2, -0.1];
  assert.deepEqual(controls.pitchRange, [-1.2, -0.1]);
  assert.ok(Math.abs(c.maximumTiltAngle - (Math.PI / 2 - 0.1)) < 1e-12);
  controls.pitchRange = [-Math.PI / 2, Math.PI / 2];
  assert.equal(c.maximumTiltAngle, undefined, 'unrestricted again');
  c.maximumTiltAngle = Math.PI / 2;
  assert.deepEqual(controls.pitchRange, [-Math.PI / 2, 0], 'a direct write');
  assert.throws(() => (controls.pitchRange = [0.5, 0.1]), RangeError);
  assert.throws(() => (controls.pitchRange = [NaN, 0]), RangeError);
});

test('zoomInputs name the zoom bindings and keep unnamed ones', () => {
  const scene = sceneWithController();
  const c = scene.screenSpaceCameraController;
  const { controls } = createCesiumControls({ scene });
  assert.deepEqual(controls.zoomInputs, ['rightDrag', 'wheel', 'pinch']);
  const odd = { eventType: LEFT_DRAG, modifier: SHIFT };
  c.zoomEventTypes = [...c.zoomEventTypes, odd];
  controls.zoomInputs = ['wheel', 'ctrlWheel', 'wheel'];
  assert.deepEqual(c.zoomEventTypes, [
    odd,
    WHEEL,
    { eventType: WHEEL, modifier: CTRL },
  ]);
  assert.deepEqual(controls.zoomInputs, ['wheel', 'ctrlWheel']);
  c.zoomEventTypes = PINCH;
  assert.deepEqual(controls.zoomInputs, ['pinch'], 'a single binding');
  c.zoomEventTypes = undefined;
  assert.deepEqual(controls.zoomInputs, []);
  assert.throws(() => (controls.zoomInputs = ['scroll']), TypeError);
});

test('suspend shares the scene’s holds with other users', () => {
  const scene = sceneWithController();
  const c = scene.screenSpaceCameraController;
  const { controls, dispose } = createCesiumControls({ scene });
  const other = acquireCameraInput(scene);
  assert.equal(controls.enabled, true);
  const drag = other.suspend('drag');
  assert.equal(controls.enabled, false, 'another user’s hold counts');
  const mine = controls.suspend('cockpit');
  drag();
  assert.equal(controls.enabled, false);
  assert.equal(c.enableInputs, false);
  mine();
  mine();
  assert.equal(controls.enabled, true);
  // Cesium's own flights write enableInputs off and on.
  c.enableInputs = false;
  assert.equal(controls.enabled, false, 'off while Cesium has input off');
  c.enableInputs = true;
  controls.suspend('left out');
  dispose();
  assert.equal(other.enabled, true, 'dispose gives back this port’s holds');
  other.release();
  assert.equal(c.enableInputs, true);
});

test('reading enabled leaves the controller’s enableInputs alone', () => {
  const scene = sceneWithController();
  const c = scene.screenSpaceCameraController;
  const { controls } = createCesiumControls({ scene });
  assert.equal(controls.enabled, true);
  assert.equal(
    Object.getOwnPropertyDescriptor(c, 'enableInputs').value,
    true,
    'still a plain property',
  );
  c.enableInputs = false;
  assert.equal(controls.enabled, false);
});

test('a scene without a controller still has settings', () => {
  const { controls } = createCesiumControls({ scene: {} });
  assert.equal(controls.enabled, true);
  const release = controls.suspend('x');
  assert.equal(controls.enabled, false);
  release();
  controls.zoomFactor = 9;
  assert.equal(controls.zoomFactor, 9);
  assert.deepEqual(controls.zoomInputs, ['rightDrag', 'wheel', 'pinch']);
});
