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

test('classifyHandPose works with { x, y, z } object landmarks for pinch and peace', () => {
  // Object-based landmarks (e.g. MediaPipe / HandTracker)
  const objLandmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  objLandmarks[4] = { x: 0.5, y: 0.5, z: 0 };
  objLandmarks[8] = { x: 0.52, y: 0.51, z: 0 };

  const pinchRes = classifyHandPose(objLandmarks);
  assert.equal(pinchRes.name, 'pinch');
  assert.equal(pinchRes.icon, '🤏');

  // Peace sign with object landmarks: wrist at bottom, index & middle up, ring & pinky down
  const peaceLandmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.8, z: 0 }));
  peaceLandmarks[0] = { x: 0.5, y: 0.9, z: 0 }; // Wrist
  peaceLandmarks[8] = { x: 0.45, y: 0.2, z: 0 }; // Index extended high
  peaceLandmarks[12] = { x: 0.55, y: 0.2, z: 0 }; // Middle extended high
  peaceLandmarks[16] = { x: 0.5, y: 0.85, z: 0 }; // Ring curled low
  peaceLandmarks[20] = { x: 0.5, y: 0.85, z: 0 }; // Pinky curled low
  const peaceRes = classifyHandPose(peaceLandmarks);
  assert.equal(peaceRes.name, 'peace');
  assert.equal(peaceRes.icon, '✌️');
});

test('mapHandToScreenCoords mirrors X and clamps properly for arrays and objects', () => {
  const coordsArr = mapHandToScreenCoords([0.2, 0.4], 1000, 500);
  assert.equal(coordsArr.x, 800); // (1 - 0.2) * 1000 = 800
  assert.equal(coordsArr.y, 200); // 0.4 * 500 = 200

  const coordsObj = mapHandToScreenCoords({ x: 0.2, y: 0.4 }, 1000, 500);
  assert.equal(coordsObj.x, 800);
  assert.equal(coordsObj.y, 200);
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
