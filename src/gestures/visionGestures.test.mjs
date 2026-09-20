import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHandPose,
  mapHandToScreenCoords,
  calculateHeadParallaxOffset,
  VisionGestureController,
} from './visionGestures.js';

test('classifyHandPose correctly handles missing or invalid landmarks', () => {
  assert.equal(classifyHandPose(null).name, 'none');
  assert.equal(classifyHandPose([]).name, 'none');
  assert.equal(classifyHandPose(new Array(10)).name, 'none');
});

test('classifyHandPose identifies thumbs up from gesture array', () => {
  const dummyLandmarks = Array.from({ length: 21 }, () => [0.5, 0.5, 0]);
  const res = classifyHandPose(dummyLandmarks, [{ gesture: 'thumbs up' }]);
  assert.equal(res.name, 'thumbs_up');
  assert.equal(res.icon, '👍');
});

test('classifyHandPose identifies pinch when thumb and index are close', () => {
  const landmarks = Array.from({ length: 21 }, () => [0.5, 0.5, 0]);
  landmarks[4] = [0.5, 0.5, 0]; // Thumb tip
  landmarks[8] = [0.52, 0.51, 0]; // Index tip (dist ~ 0.022 < 0.08)

  const res = classifyHandPose(landmarks);
  assert.equal(res.name, 'pinch');
  assert.equal(res.icon, '🤏');
});

test('mapHandToScreenCoords mirrors X and clamps properly', () => {
  const coords = mapHandToScreenCoords([0.2, 0.4], 1000, 500);
  assert.equal(coords.x, 800); // (1 - 0.2) * 1000 = 800
  assert.equal(coords.y, 200); // 0.4 * 500 = 200
});

test('calculateHeadParallaxOffset clamps offsets within safe angular limits', () => {
  const offset = calculateHeadParallaxOffset({ pitch: 10, yaw: -15 });
  assert.ok(Math.abs(offset.pitchOffset) <= 0.08);
  assert.ok(Math.abs(offset.yawOffset) <= 0.08);
});

test('VisionGestureController initializes and stops safely', () => {
  const controller = new VisionGestureController();
  assert.equal(controller.active, false);
  controller.stop();
  assert.equal(controller.active, false);
});
