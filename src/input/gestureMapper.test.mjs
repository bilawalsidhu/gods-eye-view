import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHandGesture,
  GESTURE_NAMES,
  GestureMapper,
} from './gestureMapper.js';

function createMockLandmarks({
  thumb = false,
  index = false,
  middle = false,
  ring = false,
  pinky = false,
  pinch = false,
  shaka = false,
  vSign = false,
} = {}) {
  // 21 landmarks: wrist at 0,0
  const lm = [];
  for (let i = 0; i < 21; i++) {
    lm.push({ x: 0.5, y: 0.8, z: 0 });
  }
  // Wrist at 0:
  lm[0] = { x: 0.5, y: 0.8, z: 0 };

  // Set fingers
  // Thumb: 4 vs 2 and 17
  lm[17] = { x: 0.3, y: 0.7, z: 0 };
  lm[2] = { x: 0.45, y: 0.75, z: 0 };
  lm[4] = thumb || shaka ? { x: 0.7, y: 0.6, z: 0 } : { x: 0.4, y: 0.72, z: 0 };

  // Index: tip 8 vs pip 6
  lm[6] = { x: 0.5, y: 0.6, z: 0 };
  lm[8] = index || vSign ? { x: 0.5, y: 0.3, z: 0 } : { x: 0.5, y: 0.68, z: 0 };

  // Middle: tip 12 vs pip 10
  lm[10] = { x: 0.45, y: 0.6, z: 0 };
  lm[12] = middle || vSign ? { x: vSign ? 0.6 : 0.45, y: 0.3, z: 0 } : { x: 0.45, y: 0.68, z: 0 };

  // Ring: tip 16 vs pip 14
  lm[14] = { x: 0.4, y: 0.6, z: 0 };
  lm[16] = ring ? { x: 0.4, y: 0.3, z: 0 } : { x: 0.4, y: 0.68, z: 0 };

  // Pinky: tip 20 vs pip 18
  lm[18] = { x: 0.35, y: 0.65, z: 0 };
  lm[20] = pinky || shaka ? { x: 0.25, y: 0.4, z: 0 } : { x: 0.35, y: 0.72, z: 0 };

  if (pinch) {
    lm[4] = { x: 0.5, y: 0.45, z: 0 };
    lm[8] = { x: 0.51, y: 0.46, z: 0 };
  }

  return lm;
}

test('classifyHandGesture detects Closed Fist when fingers are folded', () => {
  const lm = createMockLandmarks();
  const res = classifyHandGesture(lm);
  assert.equal(res.gesture, GESTURE_NAMES.FIST);
});

test('classifyHandGesture detects Open Palm when all fingers extended', () => {
  const lm = createMockLandmarks({
    thumb: true,
    index: true,
    middle: true,
    ring: true,
    pinky: true,
  });
  const res = classifyHandGesture(lm);
  assert.equal(res.gesture, GESTURE_NAMES.OPEN_PALM);
});

test('classifyHandGesture detects Peace Sign when index and middle are spread', () => {
  const lm = createMockLandmarks({ vSign: true });
  const res = classifyHandGesture(lm);
  assert.equal(res.gesture, GESTURE_NAMES.PEACE_SIGN);
});

test('classifyHandGesture detects Pinch when thumb and index are touching', () => {
  const lm = createMockLandmarks({ index: true, pinch: true });
  const res = classifyHandGesture(lm);
  assert.equal(res.gesture, GESTURE_NAMES.PINCH);
});

test('GestureMapper applies temporal majority voting and triggers mapped action', () => {
  let actionFired = null;
  const mapper = new GestureMapper({
    holdDurationMs: 50,
    onAction: (action) => {
      actionFired = action;
    },
  });

  const fistLm = createMockLandmarks();

  // Send 4 frames of FIST
  mapper.processFrame(fistLm, 1000);
  mapper.processFrame(fistLm, 1020);
  mapper.processFrame(fistLm, 1040);
  mapper.processFrame(fistLm, 1060);

  // After 60ms (> 50ms hold), toggle_lock action should fire
  assert.equal(actionFired, 'toggle_lock');
});
