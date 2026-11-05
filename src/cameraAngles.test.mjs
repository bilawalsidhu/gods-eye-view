import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from './geo/index.js';
import { cesiumHeading, cesiumRoll, poseIsVertical } from './cameraAngles.js';
import { createFakeEngine } from './globe/testing/fakeEngine.js';

const poseAt = (heading, pitch, roll = 0) => {
  const engine = createFakeEngine();
  engine.fake.setPose({
    position: geo.cartesian3.fromDegrees(10, 45, 2000),
    heading,
    pitch,
    roll,
  });
  return engine.camera.pose();
};

test('a level north-facing pose reports Cesium heading and roll 2π', () => {
  const pose = poseAt(0, -0.5);
  assert.equal(pose.heading, 0);
  assert.equal(cesiumHeading(pose), 2 * Math.PI);
  assert.equal(cesiumRoll({ ...pose, roll: 0 }), 2 * Math.PI);
  assert.equal(poseIsVertical(pose), false);
});

test('a straight-down pose keeps roll 0; other angles pass through', () => {
  const down = poseAt(0, -Math.PI / 2);
  assert.equal(poseIsVertical(down), true);
  assert.equal(cesiumRoll(down), 0);
  const oblique = { ...poseAt(1, -0.5), heading: 1.25, roll: 0.5 };
  assert.equal(cesiumHeading(oblique), 1.25);
  assert.equal(cesiumRoll(oblique), 0.5);
});
